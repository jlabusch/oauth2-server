var config = require('./config'),
    pkg = require('../package.json'),
    cluster = require('cluster'),
    syslog = require('node-syslog');

var __priority_name_to_num = {
    'debug': syslog.LOG_DEBUG,   // Anything goes
    'info': syslog.LOG_INFO,     // e.g. detailed transaction logic traces
    'notice': syslog.LOG_NOTICE, // e.g. HTTP traces
    'warn': syslog.LOG_WARNING,  // e.g. an error during a single login POST
    'error': syslog.LOG_ERR,     // e.g. service configuration fundamentally broken, exiting
    'crit': syslog.LOG_CRIT      // Try not to use this
};

var __facility_name_to_num = {
    'local0': syslog.LOG_LOCAL0,
    'local1': syslog.LOG_LOCAL1,
    'local2': syslog.LOG_LOCAL2,
    'local3': syslog.LOG_LOCAL3,
    'local4': syslog.LOG_LOCAL4,
    'local5': syslog.LOG_LOCAL5,
    'local6': syslog.LOG_LOCAL6,
    'local7': syslog.LOG_LOCAL7
};

var process_name = 'master';
exports.name = function(n){ process_name = n; }

var __log_init = false;
function init() {
    if (!__log_init) {
        var facility = 'local4';
        if (config.loaded()) {
            facility = config.get('logging').facility || facility;
        }
        facility = __facility_name_to_num[facility];

        syslog.init(pkg.name, syslog.LOG_PID, facility);

        __log_init = true;
    }
}

function log(pri, msg){
    init();

    if (arguments.length < 2){
        msg = pri;
        pri = 'info';
    }
    if (!msg){
        return;
    }
    var id = cluster.isMaster ? process_name : cluster.worker.id;

    var level = 'info'; // default to "info" if config hasn't loaded yet
    if (config.loaded()){
        level = config.get('logging').level || level;
    }
    level = __priority_name_to_num[level] || -1; // impossibly important, i.e. log nothing if level is bad

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
    init();

    level = level || 'notice';
    return function(req, res, next){
        function t(x){ return x || '-'; }
        function remoteAddr(x){ return x.socket && (x.socket.remoteAddress || (x.socket.socket && x.socket.socket.remoteAddress)); }
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
                    t(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || remoteAddr(req)),
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

