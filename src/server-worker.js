var express = require('express'),
    passport = require('passport'),
    fs = require('fs'),
    cluster = require('cluster'),
    log = require('../lib/logging').log,
    http_log = require('../lib/logging').http_log,
    config = require('../lib/config'),
    site = require('./site'),
    oauth2 = require('./oauth2'),
    user = require('./user'),
    app = null;

exports.run = function(){
    process.on('message', function(m){
        if (m === 'reload'){
            config.reload();
        }else{
            log('warn', 'Unhandled message from master: ' + JSON.stringify(m));
        }
    });

    config.defer(function(err, cfg){
        // TODO: should check err arg

        if (cfg.auth_server.ssl){
            var ssl_key = fs.readFileSync(cfg.auth_server.ssl_key, 'utf8'),
                ssl_cert = fs.readFileSync(cfg.auth_server.ssl_cert, 'utf8');
            log('info', 'Creating SSL server...');
            app = express.createServer({key: ssl_key, cert: ssl_cert});
        }else{
            log('info', 'Creating HTTP server...');
            app = express.createServer();
        }

        var storage = require('../lib/store.js');
        var store = storage.createSync('session');
        if (!store){
            log('error', "Couldn't allocate session storage");
            process.exit(1);
        }

        app.set('view engine', 'ejs');
        app.set('layout', cfg.auth_server.views.layout || 'layout');
        app.use(http_log());
        app.use(express.cookieParser());
        app.use(express.bodyParser());
        app.use(express.session({
            store: store,
            secret: cfg.auth_server.session_secret,
            key: 'sid',
            // TODO: proxy: !cfg.auth_server.ssl, cookie.secure always true
            cookie: {secure: cfg.auth_server.ssl}
        }));
        app.use(passport.initialize());
        app.use(passport.session());

        app.use(express.static(__dirname + '/../static/'));

        require('./auth.js');

        // GET /login
        //
        // Shows a resource_server-specific login page to the user.
        app.get('/login', site.loginForm);

        // POST /login {username: U, password: P}
        //
        // Target for site.loginForm. Passes the credentials to the LocalStrategy
        // configured in auth.js.
        app.post('/login', site.login);

        // GET /logout
        //
        // Destroys the user's session. Probably never used in our workflow.
        app.get('/logout', site.logout);

        // GET /authorize
        //
        // Prompts the user for consent based on the client and scope
        // Tied to previous login transaction with session cookie named "sid"
        app.get('/authorize', oauth2.authorization);

        // POST /authorize {transaction_id: T, scope: S, [, cancel: "Deny"]}
        //
        // User consents/refuses access to the requested scope
        app.post('/authorize', oauth2.decision);

        // POST /token {grant_type: "authorization_code", code: C, client_id: I, client_secret: S, redirect_uri: R}
        //
        // Client site exchanges a short lived auth code for a long lived access token.
        // The Client credentials may also be passed in the Basic Auth header.
        // The redirect URI must appear in the validRedirects list for that Client.
        app.post('/token', oauth2.token);

        // GET /review
        //
        // Allows users to review/revoke any existing tokens they've issued
        app.get('/review', oauth2.authorization_review);

        // POST /review {revoke: [<client_id>, ...] [, cancel: "Cancel"]}
        //
        // Act on the decisions taken in /review. Revokes both access tokens and refresh tokens
        // for the listed clients
        app.post('/review', oauth2.decision_update);

        // GET /api/userinfo
        //
        // Pulls user metadata from the resource server.
        // Access token passes as Bearer authorization header.
        app.options('/api/:fn', user.preflight);
        app.get('/api/:fn', user.api);

        app.get('/healthcheck', function(req, res){
            res.send(new Date().getTime() + '\r\n');
        });

        app.use(function(err, req, res, next){
            try{
                res.statusCode = 500;
                log('error', err.stack);
                if (cfg.auth_server.views.error){
                    res.render(cfg.auth_server.views.error, {message: err.message});
                    return;
                }
            }catch(ex){
                log('error', 'Exception in error handler: ' + ex);
            }
            res.end();
        });

        app.listen(cfg.auth_server.port, function(){
            log('info', 'Running on port ' + cfg.auth_server.port);
        });
    });
}
