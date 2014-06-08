var log = require('./logging').log,
    shorten = require('./logging').format_sid,
    config = require('./config'),
    util = require('util'),
    prepender = require('../lib/utils').prepender,
    ExpressStore = require('express').session.Store;

function maybe_shorten(key){
    if (key && typeof(key) === 'string' && key.length > 20){
        return shorten(key);
    }
    return key;
}

function timed_finish(label, next){
    var t0 = new Date;
    log('debug', label + ' - timer started');
    return function(err, result){
        var t1 = new Date;
        log('info', label + ' - ' + (t1-t0) + 'ms');
        if (next){
            next.apply(this, arguments);
        }
    }
}

/*
 *  Module interface
 *
 *  configuration:
 *      storage.type = [MemStore | Redis | ...]
 *
 *  import:
 *      var storage = require('./lib/store');
 *
 *      var store;
 *      storage.create('my_table', function(err, obj){
 *          store = obj;
 *      });
 *
 *      //alternative, useful if you know config has been loaded
 *      var store = storage.createSync('my_table');
 *
 *  access:
 *      store.put(key, value, function(err_or_null){});
 *
 *      store.transaction(options, function(err_or_null){});
 *        - options: {
 *            dependent_keys: []      // An optional list of keys in the same table that should be
 *                                    // locked during body() if possible.
 *                                    // The values associated with these keys are looked up and passed
 *                                    // as input to body().
 *            body: function(values, commit)
 *                                    // body() defines the meat of the transaction, where put() and del()
 *                                    // calls can be executed as normal. Calling commit() will execute the
 *                                    // transaction and commit(err) will discard it. Depending on your back-
 *                                    // end the semantics will differ, e.g. PostgreSQL's BEGIN..COMMIT/ROLLBACK
 *                                    // vs. Redis' MULTI..EXEC/DISCARD.
 *          }
 *
 *      store.get(key, function(err, val){});
 *      store.get([key1, ...], function(err, val){});
 *
 *      store.del(key, function(err_or_null){});
 *
 *      store.length(function(err, val){});
 *
 *      store.clear(function(err, val){});
 *
 *      store.all(function(err, val){});
 */

// MemStore uses a REST API to talk to an in-memory store. You may want to
// implement a MemStore server as a proxy/cache between this application and
// a traditional database.
//
// Note that dummy-servers/MemStore-server.js is not suitable for production
// use because unused sessions are effectively a memory leak; we check their
// expiry on get() but don't periodically sweep through all of them to tidy up.

var http = require('http');

function MemStore(table, conf){
    this.__table = table;
    this.__config = conf;

    ExpressStore.call(this, {});
}

util.inherits(MemStore, ExpressStore);

MemStore.prototype.put = function(key, value, next){
    var self = this;
    var __func = 'MemStore[' + self.__table + '].put(' + maybe_shorten(key) + ')';
    var done = timed_finish(__func, next);
    try{
        value = JSON.stringify(value);
    }catch(ex){
        log('warn', __func + ' - couldn\'t stringify ' + value);
    }
    var opt = {
        hostname: self.__config.host,
        port: self.__config.port,
        path: '/' + self.__table + '/' + encodeURIComponent(key),
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': value.length
        }
    };
    var req = http.request(opt, function(res){
        res.on('data', function(){});
        res.on('end', function(){
            if (res.statusCode === 204 || res.statusCode === 200){
                done();
            }else{
                log('warn', __func + ' - ' + res.statusCode);
                done('Error: ' + res.statusCode);
            }
        });
    });
    req.on('error', function(e){
        log('error', __func + ' - ' + e);
        done(e);
    });
    req.write(value);
    req.end();
}

MemStore.prototype.transaction = function(options, next){
    process.nextTick(function(){ next('Not implemented'); });
}

MemStore.prototype.del = function(key, next){
    var self = this;
    var __func = 'MemStore[' + self.__table + '].del(' + maybe_shorten(key) + ')';
    var done = timed_finish(__func, next);
    var opt = {
        hostname: self.__config.host,
        port: self.__config.port,
        path: '/' + self.__table + '/' + encodeURIComponent(key),
        method: 'DELETE'
    };
    var req = http.request(opt, function(res){
        res.on('data', function(){});
        res.on('end', function(){
            if (res.statusCode === 204 || res.statusCode === 200){
                done();
            }else{
                done('Error: ' + res.statusCode);
            }
        });
    });
    req.on('error', function(e){
        log('error', __func + ' - ' + e);
        done(e);
    });
    req.end();
}

MemStore.prototype.get = function(key, next, path_override){
    if (Array.isArray(key)){
        process.nextTick(function(){ next('Not implemented'); });
        return;
    }
    var self = this;
    var __func = 'MemStore[' + self.__table + '].get(' + maybe_shorten(key) + ')';
    var done = timed_finish(__func, next);
    if (path_override){
        __func += ' ' + path_override
    }
    var opt = {
        hostname: self.__config.host,
        port: self.__config.port,
        path: path_override || '/' + self.__table + '/' + encodeURIComponent(key),
        method: 'GET'
    };
    var req = http.request(opt, function(res){
        var data = '';
        res.on('data', function(d){
            data += d;
        });
        res.on('end', function(){
            if (res.statusCode === 204){
                log('info', "Empty response for " + __func);
                done();
                return;
            }
            if (res.statusCode !== 200){
                var msg = "Error response " + res.statusCode + " for " + __func;
                log('error', msg);
                done(msg);
                return;
            }
            var json = null;
            try{
                json = JSON.parse(data);
                if (json && self.__table === 'session'){
                    // Check if the session has expired
                    if (json.cookie){
                        var e = json.cookie.expires;
                        if (typeof(e) === 'string'){
                            e = new Date(e);
                        }
                        if (new Date > e){
                            // Too old
                            json = null;
                        }
                    }else{
                        // Malformed
                        json = null;
                    }
                }
            }catch(ex){
                var msg = "Couldn't parse JSON response for " + __func + ' - ' + ex;
                log('error', msg);
                done(msg);
                return;
            }
            done(null, json);
        });
    });
    req.on('error', function(e){
        log('error', __func + ' - ' + e);
        done(e);
    });
    req.end();
}

// Connect session store compatibility
MemStore.prototype.set = MemStore.prototype.put;
MemStore.prototype.destroy = MemStore.prototype.del;

MemStore.prototype.length = function(next){
    return this.get(null, next, '/length/' + this.__table);
}

MemStore.prototype.clear = function(next){
    return this.get(null, next, '/clear/' + this.__table);
}

MemStore.prototype.all = function(next){
    return this.get(null, next, '/all/' + this.__table);
}

exports.MemStore = MemStore;

// Redis.
//
// This is an equivalent interface to modules like sessionstore and connect-redis that
// integrates nicely with our config and logging systems.
// This is a particularly good choice for session storage; it will allow the session
// cookie's maxAge/originalMaxAge to override the config's TTL value.

var redis = require('redis');

function Redis(table, conf){
    var self = this;

    this.__table = table;
    this.__config = conf;

    ExpressStore.call(this, {});

    this.__client = redis.createClient(conf.port, conf.host, conf.options);

    redis.debug_mode = false;

    // TODO: do we need to call __client.auth() if conf.options.auth_pass is set?

    this.__client.on("error", function(e){
        log('error', 'Redis[' + self.__table + '] error event: ' + e);
    });

    if (conf.db){
        this.__client.select(conf.db);
    }
}

util.inherits(Redis, ExpressStore);

Redis.prototype.transaction = function(options, next){
    process.nextTick(function(){ next('Not implemented'); });
    // WATCH options.dependent_keys
    // MGET options.dependent_keys
    // MULTI
    // PUT ...
    // EXEC
}

Redis.prototype.put = function(key, value, next){
    var self = this;
    var __func = 'Redis[' + self.__table + '].put(' + maybe_shorten(key) + ')';
    var done = timed_finish(__func, next);
    try{
        // TTL order of precedence for sessions only -
        //  1. cookie.maxAge
        //  2. cookie.originalMaxAge
        //  3. config:storage.(<table>|"default").ttl (default 4h)
        //
        // If TTL config is falsy and this is not a session, store for ever.

        var ttl = self.__config.ttl;
        if (self.__table === 'session'){
            if (value.cookie && value.cookie.maxAge && typeof(value.cookie.maxAge) === 'number'){
                ttl = value.cookie.maxAge / 1000 | 0;
            }else if (value.cookie && value.cookie.originalMaxAge && typeof(value.cookie.originalMaxAge) === 'number'){
                ttl = value.cookie.originalMaxAge / 1000 | 0;
            }
            ttl = ttl || 14400;
            log('debug', __func + ' Session TTL will be ' + ttl);
        }

        key = self.__table + ':' + key;
        value = JSON.stringify(value);
        var handler = function(err){
            if (err){
                log('error', __func + ' - ' + err);
            }
            done();
        };

        if (ttl){
            self.__client.setex(key, ttl, value, handler);
        }else{
            self.__client.set(key, value, handler);
        }
    }catch(ex){
        log('error', __func + ' - ' + ex);
        process.nextTick(function(){ done(ex); });
    }
}

Redis.prototype.get = function(keys, next){
    if (Array.isArray(keys) == false){
        keys = [keys];
    }
    var self = this;
    var __func = 'Redis[' + self.__table + '].get([' + keys.map(maybe_shorten).join(', ') + '])';
    var done = timed_finish(__func, next);
    keys = keys.map(prepender(self.__table + ':'));
    self.__client.mget(keys, function(err, result){
        if (err){
            log('error', __func + ' - MGET: ' + err);
            done(err);
            return;
        }
        try{
            // Any items that didn't have a matching key are simply missing from the response,
            // there's no helpful (nil) message. Fix up the JSON and run with that.
            result = result ? result.toString() : '';
            result = result.replace(/^,/,   '') // strip leading comma
                           .replace(/,,/g, ',') // strip empty fields
                           .replace(/,$/, '');  // strip trailing comma
            // Also add in brackets. Oh redis :(
            if (keys.length > 1){
                result = '[' + result + ']';
            }
            if (result){
                result = JSON.parse(result);
            }
        }catch(ex){
            log('error', __func + ' - parse(): ' + ex);
            done(ex);
            return;
        }
        done(null, result);
    });
}

Redis.prototype.del = function(key, next){
    var self = this;
    var __func = 'Redis[' + self.__table + '].del(' + maybe_shorten(key) + ')';
    var done = timed_finish(__func, next);
    self.__client.del(self.__table + ':' + key, function(err){
        if (err){
            log('error', __func + ' - ' + err);
        }
        done.apply(this, arguments);
    });
}

// Connect session store compatibility
Redis.prototype.set = Redis.prototype.put;
Redis.prototype.destroy = Redis.prototype.del;

Redis.prototype.length = function(next){
    throw 'Not implemented'; // TODO
}

Redis.prototype.clear = function(next){
    throw 'Not implemented'; // TODO
}

Redis.prototype.all = function(next){
    throw 'Not implemented'; // TODO
}

exports.Redis = Redis;

exports.create = function(table, next){
    config.defer(function(err, conf){
        // TODO: should check err arg
        var table_cfg = conf.storage[table] || conf.storage.default; 
        var s = null;
        if (exports[table_cfg.type]){
            s = new exports[table_cfg.type](table, table_cfg);
        }
        process.nextTick(function(){
            if (s){
                next(null, s);
            }else{
                log('error', 'No storage interface for configured type "' + table_cfg.type + '"');
                next("Couldn't allocate storage of type " + table_cfg.type);
            }
        });
    });
}

exports.createSync = function(table){
    if (!config.loaded()){
        throw 'config.createSync called before config loaded';
    }
    var section_cfg = config.get('storage');
    var table_cfg = section_cfg[table] || section_cfg.default; 
    if (exports[table_cfg.type]){
        return new exports[table_cfg.type](table, table_cfg);
    }
    log('error', 'No storage interface for configured type "' + table_cfg.type + '"');
    return null;
}



