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
    crypto = require('crypto'),
    app = express.createServer();

app.use(logger.http_log('info'));
app.use(express.bodyParser());
app.use(express.cookieParser());
app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));

var users = {};

app.post('/login', function(req, res){
    var password = req.param('password');
    if (password !== 'password'){
        res.send(401);
        return;
    }
    var username = req.param('username');
    var h = crypto.createHash('sha1');
    h.update(username + ':' + password);
    var token = h.digest('hex');
    res.cookie('dummy-server-token', token);
    users[token] = {id: username, name: 'user_' + Object.keys(users).length};
    logger.log('debug', token + ' => ' + JSON.stringify(users[token]));
    var r = {id: username};
    logger.log('debug', '/login response ' + JSON.stringify(r));
    res.json(r);
});

app.get('/info', function(req, res){
    var token = req.param('token');
    var r = token && users[token] || {};
    logger.log('debug', '/info response ' + JSON.stringify(r) + ' for ' + token);
    res.json(r);
});

config.defer(function(err, conf){
    logger.name('dummy-RS');

    var port = conf.resource_server.port;
    
    if (conf.resource_server.type === 'dummy'){
        logger.log('notice', 'Starting dummy-resource-server on port ' + port);
        app.listen(port);
    }else{
        logger.log('notice', 'dummy-resource-server not configured; server not starting.');
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
