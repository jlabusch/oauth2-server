var config = require('./config'),
    pkg = require('../package.json'),
    cluster = require('cluster'),
    syslog = require('node-syslog');

syslog.init(pkg.name, syslog.LOG_PID, syslog.LOG_LOCAL4);

var __priority_name_to_num = {
    'debug': syslog.LOG_DEBUG,   // Anything goes
    'info': syslog.LOG_INFO,     // e.g. detailed transaction logic traces
    'notice': syslog.LOG_NOTICE, // e.g. HTTP traces
    'warn': syslog.LOG_WARNING,  // e.g. an error during a single login POST
    'error': syslog.LOG_ERR,     // e.g. service configuration fundamentally broken, exiting
    'crit': syslog.LOG_CRIT      // Try not to use this
};

var process_name = 'master';
exports.name = function(n){ process_name = n; }

function log(pri, msg){
    if (arguments.length < 2){
        msg = pri;
        pri = 'info';
    }
    if (!msg){
        return;
    }
    var id = cluster.isMaster ? process_name : cluster.worker.id;
    var level = __priority_name_to_num[
                    config.loaded() ? config.get('logging').level : 'info' // default to "info" if config hasn't loaded yet
                ] || -1; // impossibly important, i.e. log nothing if level is bad

    var p = __priority_name_to_num[pri] || 9999; // log nothing if pri is bad
    if (p <= level){
        syslog.log(p, id + '.' + pri + '| ' + msg);
    }
}

exports.log = log;

function format_sid(req_or_str){
    function shorten(x){
        if (config.get('logging').short_sid){
            return x.replace(/^(....)(.*)(....)$/, '$1..$3');
        }else{
            return x;
        }
    }
    if (req_or_str && req_or_str.cookies && req_or_str.cookies.sid){
        return shorten(req_or_str.cookies.sid);
    }else if (typeof(req_or_str) === 'string'){
        return shorten(req_or_str);
    }
    return null; // this is intentional
}

exports.format_sid = format_sid;

// This is similar to connect.logger('tiny'), but we have control over the log() function.
function http_log(level){
    level = level || 'notice';
    return function(req, res, next){
        function t(x){ return x || '-'; }
        function shortsid(r){
        }
        var __end = res.end;
        req.__startTime = new Date();
        res.end = function(){
            res.end = __end;
            res.end.apply(res, arguments);

            var len = parseInt(res.getHeader('Content-Length'), 10);
            len = isNaN(len) ? '' : len + ' bytes';
            var auth = req.headers['authorization'];
            if (auth){
                var bearer = auth.match(/Bearer (.*)/);
                if (bearer){
                    auth = 'Bearer ' + format_sid(bearer[1]);
                }
            }
            log(
                level,
                [
                    t(req.headers['x-real-ip']),
                    t(req.method),
                    t(req.originalUrl),
                    t(auth),
                    t(res.statusCode),
                    t(len),
                    format_sid(req) || '(no session)',
                    '-',
                    (new Date - req.__startTime),
                    'ms'
                ].join(' ')
            );
        };
        next();
    }
}

exports.http_log = http_log;

