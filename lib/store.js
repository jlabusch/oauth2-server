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
 *      storage.type = [Redis | Postgres ...]
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
 *        - equivalent to SQL "upsert".
 *
 *      store.append(key, value, function(err_or_null){});
 *        - like put(), but appends "value" to an array of existing values.
 *          Manages locking etc. in an implementation defined way.
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
 *        - "val" is an array unless exactly one key was listed and the DB returned exactly one record.
 *
 *      store.del(key, function(err_or_null){});
 *
 *      store.length(function(err, val){});
 *
 *      store.clear(function(err, val){});
 *
 *      store.all(function(err, val){});
 */

// Blackhole.
//

function Blackhole(table, conf){
    var self = this;

    this.__table = table;

    ExpressStore.call(this, {});
}

util.inherits(Blackhole, ExpressStore);

Blackhole.prototype.transaction = function(options, next){
    process.nextTick(function(){ next && next() });
}

Blackhole.prototype.put = function(key, value, next){
    process.nextTick(function(){ next && next() });
}

Blackhole.prototype.append = function(key, value, next){
    process.nextTick(function(){ next && next() });
}

Blackhole.prototype.get = function(keys, next){
    process.nextTick(function(){ next && next() });
}

Blackhole.prototype.del = function(keys, next){
    process.nextTick(function(){ next && next() });
}

Blackhole.prototype.set = Blackhole.prototype.put;
Blackhole.prototype.destroy = Blackhole.prototype.del;

exports.Blackhole = Blackhole;

// Postgres.
//
// Note: The Postgres store is optimised for append(), while Redis is optimised for put().

function pg_reconnect(store, done){
    var opt = store.__config.options;
    if (!opt){
        log('error', 'Postgres[' + store.__table + '] not properly configured.');
        done && done('Data store not configured');
        return;
    }
    var name = "postgress://" + opt.user + ':<pass>@' +
                opt.host + ':' + opt.port + '/' + opt.database;
    log('debug', 'pg_reconnect(' + name + ')');
    if (store.__client){
        try{ store.__client.end(); }
        catch(ex){ /* don't care */ }
    }
    store.__client = new (require('pg')).Client(opt);
    store.__client.connect(function(err){
        if (err){
            log('error', "Couldn't connect to " + name + ' - ' + err);
        }
        done && done(err);
    });
}

function Postgres(table, conf){
    var self = this;

    this.__table = table;
    this.__config = conf;

    ExpressStore.call(this, {});

    (require('pg')).on('error', function(err){
        log('error', 'Postgres[' + self.__table + '] error event: ' + e);
        pg_reconnect(self);
    });

    var SQL_TABLE_EXISTS = 
            "select exists(" +
                "select * from information_schema.tables " +
                "where table_schema='public' and table_name='" + self.__table + "'" +
            ")",
        // TODO: Should also create index on key
        SQL_CREATE_TABLE =
            'create table ' + self.__table + '(' +
                'id bigserial PRIMARY KEY,' +
                'key text NOT NULL,' +
                'value text NOT NULL,' +
                'mtime timestamp with time zone default NOW()' +
            ')';

    this.__client = null;
    pg_reconnect(self, function(err){
        var __func = 'Postgres[' + self.__table + ']';
        if (err){
            log('error', __func + ' failed to connect to DB');
            return;
        }
        function table_exists(data){
            return data.rows && data.rows.length > 0 && data.rows[0].exists;
        }
        function check_table(fn_if_not_exists){
            self.__client.query(SQL_TABLE_EXISTS, function(err, data){
                if (err){
                    log('error', __func + " can't determine whether table exists - " + err);
                    return;
                }
                if (table_exists(data)){
                    log('info', __func + ' table already exists');
                }else{
                    fn_if_not_exists();
                }
            });
        }
        function create_table(){
            self.__client.query(
                SQL_CREATE_TABLE,
                function(err){
                    if (err){
                        log('error', __func + " can't create table - " + err);
                    }else{
                        log('notice', __func + " created table");
                    }
                }
            );
        }
        // The double-checked locking pattern has some subtle issues, but failure has
        // no real consequences in this case.
        check_table(function(){
            setTimeout(
                check_table(create_table),
                (Math.random()*1000)|0  // Random milliseconds between [0-1000)
            );
        });
    });
}

util.inherits(Postgres, ExpressStore);

Postgres.prototype.transaction = function(options, next){
    process.nextTick(function(){ next('Not implemented'); });
}

Postgres.prototype.put = function(key, value, next){
    var self = this;
    if (!self.__client){
        pg_reconnect(self, function(err){
            if (!err){
                self.put(key, value, next);
            }
        });
        return;
    }
    var __func = 'Postgres[' + self.__table + '].put(' + maybe_shorten(key) + ')';
    var done = timed_finish(__func, next);

    value = JSON.stringify(value);
    function if_ok(then){
        return function(err, data){
            if (err){
                log('error', __func + ' - ' + err);
                return self.__client.query('rollback', function(){ done(err) });
            }
            then(data);
        }
    }
    self.__client.query(
        'begin',
        if_ok(function(){
            self.__client.query(
                'update ' + self.__table + ' set value=$1,mtime=NOW() where key=$2',
                [value, key],
                if_ok(function(data){
                    if (data.rowCount > 0){
                        log('debug', 'update succeeded on first try');
                        return self.__client.query('commit', done);
                    }
                    log('debug', 'update failed, trying insert');
                    self.__client.query(
                        'savepoint alpha',
                        if_ok(function(){
                            self.__client.query(
                                'insert into ' + self.__table + ' (key,value) values ($1,$2)',
                                [key, value],
                                if_ok(function(data){
                                    if (data.rowCount > 0){
                                        // TODO: clarify if we need RELEASE SAVEPOINT alpha
                                        log('debug', 'insert succeeded');
                                        return self.__client.query('commit', done);
                                    }
                                    log('debug', 'insert failed, trying update again');
                                    self.__client.query(
                                        'rollback to savepoint alpha',
                                        if_ok(function(){
                                            self.__client.query(
                                                'update ' + self.__table + ' set value=$1,mtime=NOW() where key=$2',
                                                [value, key],
                                                if_ok(function(data){
                                                    log('debug', 'second insert: ' + JSON.stringify(data));
                                                    return self.__client.query('commit', done);
                                                })
                                            );
                                        })
                                    );
                                })
                            );
                        })
                    );
                })
            );
        })
    );
}

Postgres.prototype.append = function(key, value, next){
    var self = this;
    if (!self.__client){
        pg_reconnect(self, function(err){
            if (!err){
                self.put(key, value, next);
            }
        });
        return;
    }
    var __func = 'Postgres[' + self.__table + '].append(' + maybe_shorten(key) + ')';
    var done = timed_finish(__func, next);

    value = JSON.stringify(value);
    self.__client.query(
        'insert into ' + self.__table + ' (key,value) values ($1,$2)',
        [key, value],
        function(err){
            if (err){
                log('error', __func + ' - ' + err);
            }
            done();
        }
    );
}

Postgres.prototype.get = function(keys, next){
    var self = this;
    if (!self.__client){
        pg_reconnect(self, function(err){
            if (!err){
                self.put(key, value, next);
            }
        });
        return;
    }
    if (Array.isArray(keys) == false){
        keys = [keys];
    }
    var __func = 'Postgres[' + self.__table + '].get(' + keys.map(maybe_shorten).join(', ') + ')';
    var done = timed_finish(__func, next);

    self.__client.query(
        'select * from ' + self.__table + ' where key in (' + keys.map(function(x, i){return '$'+(i+1)}) + ')',
        keys,
        function(err, data){
            if (err){
                log('error', __func + ' - ' + err);
                done(err);
                return;
            }
            var result = [];
            try{
                result = data.rows.map(function(r){
                    log('debug', 'row   : ' + JSON.stringify(r));
                    var j = JSON.parse(r.value);
                    log('debug', 'parsed: ' + JSON.stringify(j));
                    return j;
                });
            }catch(ex){
                log('error', __func + ' - exception: ' + ex);
                done(ex);
                return;
            }
            if (keys.length === 1){
                if (result.length > 1){
                    log('info', __func + ' multiple results found for single key');
                }
                if (result.length  === 1){
                    result = result[0];
                }
            }
            done(null, result);
        }
    );
}

Postgres.prototype.del = function(key, next){
    var self = this;
    if (!self.__client){
        pg_reconnect(self, function(err){
            if (!err){
                self.put(key, value, next);
            }
        });
        return;
    }
    var __func = 'Postgres[' + self.__table + '].del(' + maybe_shorten(key) + ')';
    var done = timed_finish(__func, next);

    self.__client.query(
        'delete from ' + self.__table + ' where key = $1',
        [key],
        function(err){
            if (err){
                log('error', __func + ' - ' + err);
            }
            done.apply(this, arguments);
        }
    );
}

// Connect session store compatibility
Postgres.prototype.set = Postgres.prototype.put;
Postgres.prototype.destroy = Postgres.prototype.del;

Postgres.prototype.length = function(next){
    process.nextTick(function(){ next('Not implemented'); }); // TODO
}

Postgres.prototype.clear = function(next){
    process.nextTick(function(){ next('Not implemented'); }); // TODO
}

Postgres.prototype.all = function(next){
    process.nextTick(function(){ next('Not implemented'); }); // TODO
}

exports.Postgres = Postgres;

// Redis.
//
// This is an equivalent interface to modules like sessionstore and connect-redis that
// integrates nicely with our config and logging systems.
// This is a particularly good choice for session storage; it will allow the session
// cookie's maxAge/originalMaxAge to override the config's TTL value.

function Redis(table, conf){
    var self = this;

    this.__table = table;
    this.__config = conf;

    ExpressStore.call(this, {});

    this.__client = (require('redis')).createClient(conf.port, conf.host, conf.options);

    (require('redis')).debug_mode = false;

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

Redis.prototype.append = function(key, value, next){
    var self = this;
    var __func = 'Redis[' + self.__table + '].append(' + maybe_shorten(key) + ')';
    var done = timed_finish(__func, next);

    process.nextTick(function(){ next('Not implemented'); });
    // WATCH options.dependent_keys
    // MGET options.dependent_keys
    // MULTI
    // PUT ...
    // EXEC
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
    process.nextTick(function(){ next('Not implemented'); }); // TODO
}

Redis.prototype.clear = function(next){
    process.nextTick(function(){ next('Not implemented'); }); // TODO
}

Redis.prototype.all = function(next){
    process.nextTick(function(){ next('Not implemented'); }); // TODO
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



