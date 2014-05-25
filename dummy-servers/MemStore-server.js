require('daemon')();

var logger = require('../lib/logging'),
    config = require('../lib/config'),
    fs = require('fs');

var PIDFILE = process.argv[1] + '.pid';
fs.writeFile(PIDFILE, process.pid + '\n', function(err){
    if (err){
        logger.log('error', "Couldn't write process ID to " + PIDFILE);
    }else{
        logger.log('notice', "Created " + PIDFILE);
    }
});

var express = require('express'),
    app = express.createServer();

app.use(logger.http_log('info'));
app.use(express.bodyParser());
app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));

var tables = {};

var access_fns = {
    session: {
        put: function(key, val){
            tables['session'] = tables['session'] || {index: {}, data: {}};
            var s = tables.session;
            if (val && val.passport){
                var u = val.passport.user;
                // If this is an authenticated user (i.e. with a UID), update the index
                if (u){
                    // Delete existing records (which are possibly for a different session ID).
                    // This prevents simultaneous access by the same person in two sessions.
                    var existing = s.data[u];
                    if (existing){
                        delete s.index[existing.key]
                    }
                    // Store a link in the index from this session ID to a user ID
                    s.index[key] = {indexed: true, uid_or_session: u};
                    // Store the session ID and value against the user ID
                    s.data[u] = {key: key, session: val};
                }else{
                    s.index[key] = {indexed: false, uid_or_session: val}
                }
                return true;
            }
            return false;
        },
        get: function(key){
            tables['session'] = tables['session'] || {index: {}, data: {}};
            var u = tables.session.index[key];
            if (u){
                return u.indexed ?
                    tables.session.data[u.uid_or_session].session :
                    u.uid_or_session;
            }
            return null;
        },
        del: function(key){
            tables['session'] = tables['session'] || {index: {}, data: {}};
            var u = tables.session.index[key];
            if (u){
                if (u.indexed){
                    delete tables.session.data[u.uid_or_session];
                }
                delete tables.session.index[key];
            }
        }
    }
}

app.get('/clear/:table', function(req, res){
    tables[req.params.table] = null;
    res.end();
});

// TODO: REMOVE ME
app.get('/dump', function(req, res){
    res.json(tables);
});

app.get('/all/:table', function(req, res){
    var t = req.params.table;
    var arr = [];

    if (tables[t]){
        try{
            if (tables[t].index){
                Object.keys(tables[t].index).forEach(function(k){
                    arr.push(access_fns[t].get(k));
                });
            }else{
                Object.keys(tables[t]).forEach(function(j){
                    arr.push(tables[t][k]);
                });
            }
        }catch(ex){
            logger.log('error', 'Couldn\'t GET all from "' + t + '": ' + ex);
        }
    }
    res.json(arr);
});

app.get('/length/:table', function(req, res){
    var t = req.params.table;
    var ks = [];
    if (tables[t]){
        if (tables[t].index){
            ks = Object.keys(tables[t].index);
        }else{
            ks = Object.keys(tables[t]);
        }
    }
    res.json(ks.length);
});

app.get('/:table/:key', function(req, res){
    var k = decodeURIComponent(req.params.key);
    var t = req.params.table;
    var v = undefined;

    if (access_fns[t]){
        try{
            v = access_fns[t].get(k);
        }catch(ex){
            var msg = 'Couldn\'t GET from "' + t + '": ' + ex;
            logger.log('error', msg);
            res.send(500, {error: msg});
        }
    }else{
        tables[t] = tables[t] || {};
        v = tables[t][k];
    }
    res.json(v);
});

app.delete('/:table/:key', function(req, res){
    var k = decodeURIComponent(req.params.key);
    var t = req.params.table;

    if (access_fns[t]){
        try{
            access_fns[t].del(k);
        }catch(ex){
            var msg = 'Couldn\'t DELETE from "' + t + '": ' + ex;
            logger.log('error', msg);
            res.send(500, {error: msg});
        }
    }else{
        if (tables[t]){
            delete tables[t][k];
        }
    }
    res.end();
});

app.put('/:table/:key', function(req, res){
    var k = decodeURIComponent(req.params.key);
    var j = req.body;
    try{
        j = JSON.parse(j);
    }catch(ex){}

    var t = req.params.table;
    if (access_fns[t]){
        try{
            if (access_fns[t].put(k, j)){
                // worked
                res.end();
            }else{
                var msg = 'Invalid value format for table "' + t + '"';
                logger.log('error', msg);
                res.send(400, {error: msg});
            }
        }catch(ex){
            var msg = 'Couldn\'t PUT into "' + t + '": ' + ex;
            logger.log('error', msg);
            res.send(500, {error: msg});
        }
    }else{
        tables[req.params.table] = tables[req.params.table] || {};
        tables[req.params.table][k] = j;
        res.end();
    }
});

config.defer(function(err, conf){
    logger.name('MemStore-server');

    var needed = false;
    var port = 8083;
    Object.keys(conf.storage).forEach(function(s){
        if (conf.storage[s].type === 'MemStore'){
            needed = true;
            port = conf.storage[s].port;
        }
    });
    if (needed){
        logger.log('notice', 'Starting MemStore on port ' + port);
        app.listen(port);
    }else{
        logger.log('notice', 'MemStore not configured; server not starting.');
        setTimeout(function(){
            logger.log('notice', 'Unlinking ' + PIDFILE);
            fs.unlink(PIDFILE, function(err){
                if (err){
                    logger.log('error', err);
                }
                process.exit(0);
            });
        }, 1000);
    }
});
