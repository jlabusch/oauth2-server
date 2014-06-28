var fs = require('fs'),
    logger = require('./logging'),
    EventEmitter = require('events').EventEmitter,
    util = require('util'),
    cluster = require('cluster');

var CONFIG_DIR = process.env.NODE_CONFIG_DIR || './config';
var CONFIG_ENV = process.env.NODE_ENV || 'test';

/*
 *  Module interface
 *
 *  import:
 *      var config = require('./lib/config');
 *
 *  access:
 *      var section = config.get('section');
 *
 *      if (config.loaded()){
 *      }
 *
 *      config.defer(function(err, model){
 *          // Run this function when config.loaded().
 *          // Always unwinds the stack first.
 *      });
 *
 *      config.reload(filenames, function(err, model){
 *          // filenames: array of JSON config file names relative to NODE_CONFIG_DIR
 *          // function: Code to run after load
 *      });
 *
 *      config.once('loaded', function(err, model){
 *          // function: Code to run after load
 *      });
 *
 *  events:
 *      Emits "loaded" when reload() completes.
 *      Emits "need_reload" in master process on SIGHUP.
 */  

function Config(){
    this.__model = {}; // Each cluster worker has its own copy (speed > space).
    this.__loaded = false;
}

util.inherits(Config, EventEmitter);

Config.prototype.loaded = function(){
    return this.__loaded;
}

Config.prototype.get = function(section){
    if (section){
        return this.__model[section];
    }
    return this.__model;
}

Config.prototype.clear = function(){
    this.__model = {};
}

Config.prototype.defer = function(next){
    var self = this;
    var logfn = logger.log || console.log;
    if (self.__loaded){
        process.nextTick(function(){ next(null, self.__model); });
        return;
    }
    this.once('loaded', next);
}

Config.prototype.reload = function(config_names, next){
    var self = this;
    var t0 = new Date();
    self.__loaded = false;
    var logfn = logger.log || console.log;
    fs.readdir(CONFIG_DIR, function(err, files){
        if (err){
            logfn('error', "Fatal: Can't read directory " + CONFIG_DIR + ": " + err);
            process.exit(1);
        }
        var j;
        config_names = config_names || ['default.json', CONFIG_ENV + '.json', 'runtime.json'];
        config_names.forEach(function(f){
            if (files.indexOf(f) > -1){
                self.__model = merge_json(self.__model, read_json(CONFIG_DIR + '/' + f));
            }
        });
        self.__loaded = true;
        var tN = new Date();
        logfn('info', 'Config load complete in ' + (tN-t0) + 'ms');
        if (next){
            process.nextTick(function(){
                next(null, self.__model);
            });
        }
        self.emit('loaded', null, self.__model);
    });
}

var __config = new Config();

__config.reload();

var __sighup = false;

if (cluster.isMaster){
    process.on('SIGHUP', function(){ __sighup = true; });
}

setInterval(function(){
    if (__sighup){
        __sighup = false;
        __config.emit('need_reload');
    }
}, 1000);

module.exports = __config;

function read_json(f){
    var logfn = logger.log || console.log;
    var result = undefined;
    var s;
    try{
        s = fs.readFileSync(f, {encoding:'utf8'});
    }catch(ex){
        logfn('error', "Fatal: Can't read " + f + ": " + ex);
        process.exit(1);
    }
    if (s){
        try{
            result = JSON.parse(s);
        }catch(ex){
            logfn('error', "Parse error for " + f + ": " + ex);
        }
    }
    return result;
}

function merge_json(o, j){
    if (j){
        o = extend(o, j);
    }
    return o;
}

// extend(to, from..., depth) adapted from _extendDeep in node-config
function extend(mergeInto){
    var vargs = Array.prototype.slice.call(arguments, 1);
    var depth = vargs.pop();
    if (typeof(depth) != 'number'){
        vargs.push(depth);
        depth = 20;
    }

    if (depth < 0){
        return mergeInto;
    }

    function is_object(obj){
        return (obj !== null) && (typeof obj == 'object') && !(Array.isArray(obj));
    }
    vargs.forEach(function(mergeFrom){
        for (var prop in mergeFrom){
            if (is_object(mergeInto[prop]) && is_object(mergeFrom[prop])){
                // Extend recursively if both elements are objects
                extend(mergeInto[prop], mergeFrom[prop], depth - 1);
            }else{
                // Simple assignment otherwise
                mergeInto[prop] = mergeFrom[prop];
            }
        }
    });
    return mergeInto;
}

