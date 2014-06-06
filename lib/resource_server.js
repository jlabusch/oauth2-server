var log = require('../lib/logging').log,
    config = require('../lib/config'),
    db = require('../db'),
    http = require('http'),
    https = require('https');

// Interface to dummy-servers/resource_server.js
// Enabled by resource_server.type = "dummy".
// Also uses options "host", "port", "user_agent".
//
// Requirements:
//  - successful login() must add a user object to the database consisting
//    of at least {id: X, site_token: Y}, where
//     + "id" is equivalent to a UID, and
//     + "site_token" will be used when later querying user information
var dummy = {
    api: {
        scopes: ['read-only', 'read-write'],
        update_avatar: {
            scope: 'read-write',
            fn: function(req, res){
                res.json({success: 1});
            }
        },
        profile: {
            scope: 'read-only',
            fn: function(req, res){
                var conf = config.get('resource_server');
                // req.authInfo is set using the `info` argument supplied by
                // `BearerStrategy`. req.authInfo.scope is typically used to indicate
                // scope of the token, and used in access control checks.
                //
                // req.authInfo.site_token is inserted after token lookup in the BearerStrategy
                // configured in auth.js.
                var data = { scope: req.authInfo.scope };
                var opt = {
                    hostname: conf.host,
                    port: conf.port,
                    path: '/info?token=' + req.authInfo.site_token,
                    method: 'GET',
                    headers: {
                        'User-Agent': conf.user_agent,
                        'Accept': '*/*'
                    }
                };
                var rs_req = http.request(opt, function(rs_res){
                    var rs_data = '';
                    rs_res.on('data', function(d){ rs_data += d; });
                    rs_res.on('end', function(){
                        var u = undefined;
                        if (rs_res.statusCode === 200){
                            try{
                                u = JSON.parse(rs_data.toString());
                            }catch(ex){
                                log('warn', 'resource_server.dummy.query: ' + ex);
                            }
                        }
                        if (u){
                            res.json(u);
                        }else{
                            res.json({success: 0, message: 'resource server temporarily unavailable - ' + rs_res.statusCode});
                        }
                    });
                });
                rs_req.end();
                rs_req.on('error', function(e){
                    log('warn', 'resource_server.dummy.query: ' + e);
                    res.json({success: 0, message: 'resource server temporarily unavailable'});
                });
            }
        }
    },
    login: function(username, password, done){
        var conf = config.get('resource_server');
        var data = 'username=' + encodeURIComponent(username) +
                   '&password=' + encodeURIComponent(password);
        var opt = {
            hostname: conf.host,
            port: conf.port,
            path: '/login',
            method: 'POST',
            headers: {
                'User-Agent': conf.user_agent,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': data.length,
                'Accept': '*/*'
            }
        };
        var req = http.request(opt, function(res){
            var rs_data = '';
            res.on('data', function(d){ rs_data += d });
            res.on('end', function(){
                log('notice', 'user ' + username + ' auth ' + res.statusCode);
                if (res.statusCode === 200){
                    var site_token = undefined;
                    if (res.headers['set-cookie']){
                        function match_token_cookie(c){
                            var m = c.match(/^dummy-server-token=([^;]+)/);
                            if (m){
                                return m[1];
                            }
                            return null;
                        };
                        res.headers['set-cookie'].forEach(function(c){
                            site_token = site_token || match_token_cookie(c);
                        });
                    }
                    if (!site_token){
                        log('warn', 'No resource server token in 200 response for ' + username);
                        return done('No resource server logon token found in successful response');
                    }
                    var user = {};
                    try{
                        function parse_response(body, token){
                            var u = JSON.parse(body);
                            u.site_token = token;
                            return u;
                        };
                        user = parse_response(rs_data.toString(), site_token);
                    }catch(ex){
                        log('warn', 'resource_server.dummy.login: Couldn\'t parse user details (resource server token=' + site_token + ') - ' + ex);
                    }
                    if (!user.id){
                        log('error', 'resource_server.dummy.login: No "id" parameter in successful login response');
                        return done("Couldn't parse user ID in resource server login response");
                    }
                    db.users.add(user.id, user);
                    return done(null, user);
                }else{
                    return done(null, false, {message: 'Couldn\'t authenticate with resource server'});
                }
            });
        });
        req.write(data);
        req.end();
        req.on('error', function(e){
            log('warn', 'resource_server.dummy.login: ' + e);
            return done(e);
        });
    }
};

// Interface to Fairfax Media's Stuff Nation (stuff.co.nz)
// Enabled by resource_server.type = "stuff_nation".
// Also uses resource_server options "host", "port", "basic_auth, "user_agent".
var stuff_nation = {
    login: function(username, password, done){
        var conf = config.get('resource_server');
        var data = 'email=' + encodeURIComponent(username) +
                   '&password=' + encodeURIComponent(password) +
                   '&remember=remember';
        var opt = {
            hostname: conf.host,
            port: conf.port,
            path: '/loginsubmit',
            method: 'POST',
            headers: {
                'User-Agent': conf.user_agent,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': data.length,
                'Accept': '*/*'
            }
        };
        if (conf.basic_auth){
            opt.auth = conf.basic_auth;
        }
        var stock_error = "Couldn't authenticate with Stuff Nation logon service";
        var req = https.request(opt, function(res){
            var rs_data = '';
            res.on('data', function(d){ rs_data += d; });
            res.on('end', function(){
                log('notice', 'user ' + username + ' auth ' + res.statusCode);
                if (res.statusCode === 200){
                    var rememberme = undefined;
                    res.headers['set-cookie'].forEach(function(c){
                        var m = c.match(/^rememberme=([^;]+)/);
                        if (m){
                            rememberme = m[1];
                        }
                    });
                    if (!rememberme){
                        try{
                            log('debug', rs_data.toString());
                            var x = JSON.parse(rs_data.toString());
                            if (x.status === 'error' && x.error && x.error.msg){
                                log('warn', 'Stuff Nation login failed for ' + username + ' - ' + x.error.msg);
                                return done(null, false, {message: x.error.msg});
                            }
                        }catch(ex){
                            log('error', 'Exception while parsing SN login response: ' + ex);
                        }
                        log('warn', 'No Stuff Nation "rememberme" token in 200 response for ' + username + ', unknown reason');
                        return done(null, false, {message: stock_error});
                    }
                    var user = {};
                    try{
                        // We only extract this data for use in the authorization UI,
                        // e.g. to personalize a greeting.
                        user = JSON.parse(rs_data.toString()).userData;
                    }catch(ex){
                        log('warn', 'resource_server.stuff_nation.login: Couldn\'t parse user details (rememberme=' + rememberme + ') - ' + ex);
                        return done(null, false, {message: stock_error});
                    }
                    var uid = rememberme.match(/^([0-9]+)/);
                    if (uid && uid.length > 1){
                        uid = uid[1];
                    }else{
                        uid = rememberme;
                    }
                    user.id = uid;
                    user.site_token = rememberme;
                    log('debug', 'SN login object: ' + JSON.stringify(user));
                    db.users.add(uid, user);
                    return done(null, user);
                }else{
                    return done(null, false, {message: stock_error + ' - ' + res.statusCode});
                }
            });
        });
        req.write(data);
        req.end();
        req.on('error', function(e){
            log('warn', 'resource_server.stuff_nation.login: ' + e);
            return done(e);
        });
    },
    query: function(req, res){
        var conf = config.get('resource_server');
        var data = { scope: req.authInfo.scope };
        var opt = {
            hostname: conf.host,
            port: conf.port,
            path: '/_json/account_info?rememberme_token=' + req.authInfo.site_token,
            method: 'GET',
            headers: {
                'User-Agent': conf.user_agent,
                'Accept': '*/*'
            }
        };
        if (conf.basic_auth){
            opt.auth = conf.basic_auth;
        }
        var rs_req = https.request(opt, function(rs_res){
            var rs_data = '';
            rs_res.on('data', function(d){ rs_data += d; });
            rs_res.on('end', function(){
                var u = undefined;
                if (rs_res.statusCode === 200){
                    try{
                        u = JSON.parse(rs_data.toString());
                        u.id = u.uid;
                        delete u.uid;
                    }catch(ex){
                        log('warn', 'resource_server.dummy.query: ' + ex);
                    }
                }
                if (u){
                    log('debug', 'SN query object: ' + JSON.stringify(u));
                    res.json(u);
                }else{
                    res.json({success: 0, message: 'resource server temporarily unavailable - ' + rs_res.statusCode});
                }
            });
        });
        rs_req.end();
        rs_req.on('error', function(e){
            log('warn', 'resource_server.dummy.query: ' + e);
            res.json({success: 0, message: 'resource server temporarily unavailable'});
        });
    }
};

exports.dummy = dummy;
exports.stuff_nation = stuff_nation;

function loader(fn){
    return function(next){
        config.defer(function(err, conf){
            // TODO: should check err arg
            var s = null;
            if (exports[conf.resource_server.type]){
                s = exports[conf.resource_server.type][fn];
            }
            process.nextTick(function(){
                if (s){
                    next(null, s);
                }else{
                    log('error', 'Unknown resource server interface type "' + conf.resource_server.type + '"');
                    next("Unknown resource server interface type " + conf.resource_server.type);
                }
            });
        });
    }
}

var __scopes = [];

config.defer(function(err, conf){
    __scopes = exports[conf.resource_server.type].api.scopes;
});

exports.scopes = function(){
    return __scopes;
}

exports.load_api = loader('api');
exports.load_login = loader('login');

