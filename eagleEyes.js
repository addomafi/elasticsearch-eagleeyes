let es = require('elasticsearch')
let _ = require('lodash')
let extend = require('extend')
let moment = require('moment-timezone')
let request = require('request-promise-native')
// request.defaults({'proxy': '10.2.3.41:3128'})
const proxy = require('proxy-agent');
var PromiseBB = require("bluebird");
let EeAwsGlue = require("eagle-eyes-aws-glue")
var eeAwsGlue = new EeAwsGlue()

var eagleeyes = function() {
  var self = this
  self.sourceES = new es.Client({
    host: process.env.SOURCE_ELK_HOST,
		// createNodeAgent: () => proxy('http://10.2.3.41:3128'),
    log: 'warning'
  });

  self.targetES = new es.Client({
    host: process.env.TARGET_ELK_HOST,
		// createNodeAgent: () => proxy('http://10.2.3.41:3128'),
    log: 'warning'
  });

  self.timelion = {
    url: `http://${process.env.TARGET_KIBANA_HOST}/api/timelion/run`,
    headers: {
      "kbn-version": `${process.env.TARGET_KIBANA_VERSION}`
    }
  };

  self.options = {
    concurrency: parseInt(process.env.CONCURRENCY)
  };

  self._init = function() {
    return new Promise((resolve, reject) => {
      if (!self.config || process.hrtime(self.config.loadTime)[0] > 60) {
        self.sourceES.search({
          index: ".eagle-eyes-control",
          type: "delayed-alarms",
          body: {
            "query": {
              "range": {
                "timeFrame": {
                  "gte": moment().subtract(1, 'minutes').format('x'),
                  "lte": moment().format('x'),
                  "format": "epoch_millis"
                }
              }
            },
            "size": 1000
          }
        }).then(delayed => {
          self.sourceES.search({
            index: ".eagle-eyes",
            type: "alarms",
            body: {
              "query": {
                "bool": {
                  "must": [
                    {
                      "query_string": {
                        "query": "enabled:true",
                        "analyze_wildcard": true
                      }
                    }
                  ],
                  "must_not": []
                }
              },
              "size": 1000
            }
          }).then(body => {
            var alarms = [];
            body.hits.hits.forEach(function(item) {
              alarms.push(extend({
                _id: item["_id"],
                name: item["_source"].name,
                description: item["_source"].description,
                version: item["_source"].version,
                tags: item["_source"].tags
              }, JSON.parse(item["_source"].configJSON)));
            });

            // Remove delayed alarms
            if (delayed.hits.hits.length > 0) {
              // If has an item with _id = ALL dont check metrics for alarms
              if (_.filter(delayed.hits.hits, ['_id', 'ALL']).length == 0) {
                alarms = _.pullAllWith(alarms, delayed.hits.hits, function(a, b) {
                  return b["_id"] === a["_id"] || (a.tags && a.tags.indexOf(b["_id"]) > -1)
                });
              } else {
                alarms = []
              }
            }

            var now = moment().tz("America/Sao_Paulo");
						// Remove alarms that in on outage window
						alarms = _.filter(alarms, function(alarm) {
							if (alarm.outage && alarm.outage.start && alarm.outage.end) {
                var start = moment.tz(`${now.format("YYYY-MM-DD")}T${alarm.outage.start}`, "America/Sao_Paulo");
								var end = moment.tz(`${now.format("YYYY-MM-DD")}T${alarm.outage.end}`, "America/Sao_Paulo");

                // Check if need to adjust the day
                if (start.isAfter(end)) {
                  if (end.isBefore(now)) {
                    end = end.add(1, 'day')
                  } else {
                    start = start.subtract(1, 'day')
                  }

                }
								return !now.isBetween(start, end)
							}
							return true;
						})

            self.sourceES.search({
              index: ".eagle-eyes-integrations",
              type: "_doc",
              body: {
                "query": {
                  "bool": {
                    "must": [
                      {
                        "query_string": {
                          "query": "enabled:true",
                          "analyze_wildcard": true
                        }
                      }
                    ],
                    "must_not": []
                  }
                },
                "size": 1000
              }
            }).then(bodyInt => {
              var integrations = [];
              bodyInt.hits.hits.forEach(function(item) {
                integrations.push(extend({
                  _id: item["_id"],
                  name: item["_source"].name,
                  description: item["_source"].description,
                  version: item["_source"].version,
                  tags: item["_source"].tags
                }, JSON.parse(item["_source"].configJSON)));
              });

              resolve({
                loadTime: process.hrtime(),
                alarms: alarms,
                integrations: integrations
              });
            }, err => {
              reject(err.message);
            })
          }, err => {
            reject(err.message);
          })
        }, err => {
          reject(err.message);
        });
      } else {
        resolve(self.config);
      }
    });
  }

  self._sendAlarm = function(alarm, integrations) {
    var template = function(tpl, args) {
      var keys = Object.keys(args),
        fn = new Function(...keys,
          'return `' + tpl.replace(/`/g, '\\`') + '`');
      return fn(...keys.map(x => args[x]));
    };

    var sendPagerDuty = function(alarm, integration) {
      return request.post({
        "json": {
          "payload": {
            "summary": `${alarm.alarm.name} - ${template(alarm.alarm.description, alarm.alarm)}`,
            "timestamp": moment().subtract(1, 'minutes').format("YYYY-MM-DDTHH:mm:ss.SSSZ"),
            "source": alarm.alarm.name,
            "severity": "critical",
            "group": _.toString(alarm.alarm.tags),
            "class": alarm.alarm.type
          },
          "event_action": "trigger",
          "routing_key": integration.apiKey
        },
        "url": integration.endpoint
      })
    }

    var sendSlack = function(alarm, integration) {
      return request.post({
        "form": {
          "payload": JSON.stringify({
            "channel": integration.channel,
            "username": "EagleEyes",
            "text": `${alarm.alarm.name} - ${template(alarm.alarm.description, alarm.alarm)}`
          })
        },
        "url": integration.endpoint
      })
    }

    return new Promise((resolve, reject) => {
      var triggerAlarm = _.filter(integrations, function(integration) {
        return _.intersection(integration.tags, alarm.alarm.tags).length > 0
      })

      PromiseBB.map(triggerAlarm, function(item) {
        // set defaults
        if (item.type === "PAGER_DUTY") return triggerAlarm.push(sendPagerDuty(alarm, item))
        else if (item.type === "SLACK") return triggerAlarm.push(sendSlack(alarm, item))
      }, {
        concurrency: self.options.concurrency
      }).then(body => {
        resolve(body);
      }).catch(err => {
        reject(err);
      });
    });
  }

  self._checkResponseTime = function(options) {
    var rangeFilter = {};
    rangeFilter[options.timestamp] = {
      "gte": moment().subtract(1, 'minutes').subtract(options.period.value, options.period.type).format('x'),
      "lte": moment().subtract(1, 'minutes').format('x'),
      "format": "epoch_millis"
    };

    return new Promise((resolve, reject) => {
      self.targetES.search({
        index: options.index,
        body: {
          "size": 0,
          "query": {
            "bool": {
              "must": [{
                  "query_string": {
                    "analyze_wildcard": true,
                    "query": options.query
                  }
                },
                {
                  "range": rangeFilter
                }
              ],
              "must_not": []
            }
          },
          "_source": {
            "excludes": []
          },
          "aggs": {
            "timeline": {
              "date_histogram": {
                "field": options.timestamp,
                "interval": "1m",
                "time_zone": "America/Sao_Paulo",
                "min_doc_count": 1
              },
              "aggs": {
                "responseTime": {
                  "extended_stats": {
                    "field": "value"
                  }
                }
              }
            }
          }
        }
      }).then(function(body) {
        var details = [];
        if (body && body.aggregations) {
          body.aggregations.timeline.buckets.forEach(function(item) {
            if (item.responseTime["std_deviation"] > options.threshold["std_deviation"]) {
              details.push({
                "metric": "std_deviation",
                "value": Math.round(item.responseTime["std_deviation"])
              });
            } else if (item.responseTime["avg"] > options.threshold["avg"]) {
              details.push({
                "metric": "avg",
                "value": Math.round(item.responseTime["avg"])
              });
            } else if (item.responseTime["max"] > options.threshold["max"]) {
              details.push({
                "metric": "max",
                "value": Math.round(item.responseTime["max"])
              });
            }
          });

          resolve({
            alarm: options,
            details: details,
            send: details.length >= options.period.value
          });
        } else {
          resolve({
            alarm: options,
            details: details,
            send: false
          });
        }
      }, function(error) {
        console.log(error);
        reject(error.message);
      });
    });
  }

  self._checkErrorRate = function(options) {
    // TODO performance optimization
    // .es(index=${options.index}, q='${options.queryErrors}', metric=${options.metric}, timefield=${options.timestamp}).divide(.es(index=${options.index}, q='*', metric=${options.metric}, timefield=${options.timestamp})).multiply(100).label('CURRENT'), .es(index=${options.index}, q='_type: /osb-error-.*/${options.queryErrors}', metric=${options.metric}, timefield=${options.timestamp}, offset=-1w).divide(.es(index=${options.index}, q='*', metric=${options.metric}, timefield=${options.timestamp}, offset=-1w)).multiply(100).label('OFFSET'), .es(index=${options.index}, q='*', metric=${options.metric}, timefield=${options.timestamp}).divide(.es(index=${options.index}, q='*', metric=${options.metric}, timefield=${options.timestamp}, offset=-15m)).subtract(1).multiply(100).label('REQUEST_RATE')
    return new Promise((resolve, reject) => {
      request.post(extend({
        json: {
          "sheet": [
            `.es(index=${options.index}, q='${options.queryErrors}', metric=${options.metric}, timefield=${options.timestamp}, fit=none).divide(.es(index=${options.index}, q='*', metric=${options.metric}, timefield=${options.timestamp}, fit=none)).multiply(100).label('CURRENT')`
          ],
          "extended": {
            "es": {
              "filter": {
                "bool": {
                  "must": [{
                    "query_string": {
                      "analyze_wildcard": true,
                      "query": options.query
                    }
                  }]
                }
              }
            }
          },
          "time": {
            "from": moment().subtract(2, 'minutes').subtract(options.period.value, options.period.type).format("YYYY-MM-DDTHH:mm:ss.SSSZ"),
            "interval": "1m",
            "mode": "absolute",
            "timezone": "America/Sao_Paulo",
            "to": moment().subtract(1, 'minutes').format("YYYY-MM-DDTHH:mm:ss.SSSZ")
          }
        }
      }, this.timelion)).then(body => {
        var series = _.find(body.sheet[0].list, ['label', 'CURRENT'])
        var currentData = []
        if (series) {
          currentData = _.fromPairs(series.data)
        }
        var data = {
          "current": currentData
          // "offset" : _.fromPairs(_.find(body.sheet[0].list, ['label', 'OFFSET']).data),
          // "requestRate" : _.fromPairs(_.find(body.sheet[0].list, ['label', 'REQUEST_RATE']).data)
        };

        var details = [];
        var skippedFirst = false;
        Object.keys(data.current).forEach(function(item) {
          if (skippedFirst && details.length < options.period.value) {
            details.push({
              "metric": "errorRate",
              "value": data.current[item]
            });
          }
          skippedFirst = true;
        });

        resolve({
          alarm: options,
          details: details,
          send: (_.sumBy(details, 'value') / options.period.value) > options.threshold.rate
        });
      }).catch(error => {
        reject(error.message);
      });
    });
  }

  self._checkoutVariation = function(options) {
    // TODO performance optimization
    // .es(index=${options.index}, q='${options.queryErrors}', metric=${options.metric}, timefield=${options.timestamp}).divide(.es(index=${options.index}, q='*', metric=${options.metric}, timefield=${options.timestamp})).multiply(100).label('CURRENT'), .es(index=${options.index}, q='_type: /osb-error-.*/${options.queryErrors}', metric=${options.metric}, timefield=${options.timestamp}, offset=-1w).divide(.es(index=${options.index}, q='*', metric=${options.metric}, timefield=${options.timestamp}, offset=-1w)).multiply(100).label('OFFSET'), .es(index=${options.index}, q='*', metric=${options.metric}, timefield=${options.timestamp}).divide(.es(index=${options.index}, q='*', metric=${options.metric}, timefield=${options.timestamp}, offset=-15m)).subtract(1).multiply(100).label('REQUEST_RATE')
    return new Promise((resolve, reject) => {
      request.post(extend({
        "json": {
          "sheet": [
            `.es(index=${options.index}, q='${options.query}', metric=${options.metric}, timefield=${options.timestamp}, fit=none).divide(.es(index=${options.index}, q='${options.query}', metric=${options.metric}, timefield=${options.timestamp}, offset=-1w, fit=none).sum(.es(index=${options.index}, q='${options.query}', metric=${options.metric}, timefield=${options.timestamp}, offset=-2w, fit=none)).sum(.es(index=${options.index}, q='${options.query}', metric=${options.metric}, timefield=${options.timestamp}, offset=-3w, fit=none)).sum(.es(index=${options.index}, q='${options.query}', metric=${options.metric}, timefield=${options.timestamp}, offset=-4w, fit=none)).divide(4)).subtract(1).multiply(100).label('CURRENT')`
          ],
          "extended": {
            "es": {
              "filter": {
                "bool": {
                  "must": [{
                    "query_string": {
                      "analyze_wildcard": true,
                      "query": "*"
                    }
                  }]
                }
              }
            }
          },
          "time": {
            "from": moment().subtract(2, 'minutes').subtract((options.period.value*6), options.period.type).format("YYYY-MM-DDTHH:mm:ss.SSSZ"),
            "interval": `${options.period.value}${(options.period.type === 'minutes' ? 'm' : (options.period.type === 'hour' ? 'h' : 's'))}`,
            "mode": "absolute",
            "timezone": "America/Sao_Paulo",
            "to": moment().subtract(1, 'minutes').format("YYYY-MM-DDTHH:mm:ss.SSSZ")
          }
        }
      }, this.timelion)).then(body => {
        var series = _.find(body.sheet[0].list, ['label', 'CURRENT']).data;
        var details = [];
        // Check only if has sufficient data
        if (series.length > 1) {
          var data = {};
          try {
            data = {
              "current": _.fromPairs([_.head(_.takeRight(_.filter(series, s => s[1] != null),2))])
            }

            Object.keys(data.current).forEach(function(item) {
    					if ((options.threshold.rate > 0 && data.current[item] > options.threshold.rate) || (options.threshold.rate < 0 && data.current[item] < options.threshold.rate)) {
    						details.push({
    							"metric": "checkoutVariation",
    							"value": Math.round(data.current[item])
    						});
    					}
            });
          } catch(err) {
            console.log(`Discarding alarm for Checkout Variation ${options._id}-${options.name}`)
          }
        }

        // Log details
        if (details.length > 0) {
          console.log(JSON.stringify(series));
        }

        resolve({
          alarm: options,
          details: details,
          send: details.length > 0
        });
      }).catch(error => {
        reject(error.message);
      });
    });
  }

  self._glueJobs = function(options) {
    return new Promise((resolve, reject) => {
      eeAwsGlue.checkJobRun(options).then(results => {
        var alarms = []
        results.forEach(glueJob => {
          alarms.push({
            alarm: extend({
              jobId: glueJob.name,
              jobStatus: glueJob.status
            }, options),
            details: glueJob,
            send: true
          })
        })
        // Delay the next check if necessary
        if (alarms.length == 0) {
          alarms.push({
            alarm: options,
            delay: true
          })
        }
        resolve(alarms);
      }).catch(err => {
        reject(err);
      });
    })
  }
}

eagleeyes.prototype.process = function(options) {
  var self = this
  return new Promise((resolve, reject) => {
    this._init().then(config => {
      if (options && options.testList) {
        config.alarms = _.filter(config.alarms, function(item) {
          return options.testList.indexOf(item["_id"]) > -1
        })
      }

      PromiseBB.map(config.alarms, function(item) {
        // set defaults
        item = extend({
          "timestamp": "@timestamp",
          "queryErrors": "*",
          "metric": "count"
        }, item);

        if ("RESPONSE_TIME" === item.type) {
          return self._checkResponseTime(item);
        } else if ("ERROR_OCCURRENCES" === item.type) {
          return self._checkErrorRate(item);
        } else if ("CHECKOUT_VARIATION" === item.type) {
          return self._checkoutVariation(item);
        } else if ("GLUE_JOBS" === item.type) {
          return self._glueJobs(item);
        }
      }, {
        concurrency: self.options.concurrency
      }).then(results => {
        var alarms = _.filter(_.flatten(results), function(o) {return o.send || o.delay});
        if (alarms.length > 0) {
          // Send alarms
          _.filter(alarms, 'send').forEach(alarm => {
            this._sendAlarm(alarm, config.integrations).then(body => {
              console.log('Alarm was sent... ' + JSON.stringify(body));
            }).catch(err => {
              console.log('Was identified an error during the triggering of an alarm... ' + JSON.stringify(err));
            });
          });

          // Set delay
          var body = []
          alarms.forEach(function(item) {
            body.push({
              index: {
                _index: ".eagle-eyes-control",
                _type: "delayed-alarms",
                _id: item.alarm["_id"]
              }
            });
            body.push({
              "timeFrame": {
                "gte": moment().format('x'),
                "lte": moment().add(item.alarm.period.value, item.alarm.period.type).format('x')
              }
            });
          });

          // Save delay
          this.sourceES.bulk({
            body: body
          }, function(error, response) {
            console.log(JSON.stringify(response));
            if (error) {
              console.log(error);
            }
          });
        }
        resolve(results);
      }).catch(err => {
        reject(err);
      });
    }).catch(err => {
      reject(err);
    });
  });
}

module.exports = eagleeyes
