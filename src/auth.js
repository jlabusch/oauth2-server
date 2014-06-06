var passport = require('passport'),
    LocalStrategy = require('passport-local').Strategy,
    BasicStrategy = require('passport-http').BasicStrategy,
    ClientPasswordStrategy = require('passport-oauth2-client-password').Strategy,
    BearerStrategy = require('passport-http-bearer').Strategy,
    log = require('../lib/logging').log,
    short_token = require('../lib/logging').format_sid,
    config = require('../lib/config'),
    db = require('../db'),
    crypto = require('crypto'),
    librs = require('../lib/resource_server');

librs.load_login(function(err, fn){
    // TODO: check err

    // LocalStrategy
    //
    // This strategy is used to authenticate users based on a username and password.
    // Anytime a request is made to authorize an application, we must ensure that
    // a user is logged in before asking them to approve the request.
    passport.use(new LocalStrategy(fn));
});


passport.serializeUser(function(user, done){
    done(null, user.id);
});

passport.deserializeUser(function(id, done){
    db.users.find(id, function (err, user){
        done(err, user);
    });
});

// Used to authenticate clients based on the ID+secret defined in clients.json
function client_id_auth(strategy_name){
    return function(id, secret, done){
        db.clients.findByClientId(id, function(err, client){
            if (err){
                log('warn', "couldn't authenticate client with " + strategy_name + "Strategy: " + err);
                return done(err);
            }
            if (!client){
                log('warn', "couldn't authenticate client with " + strategy_name + "Strategy: no such client (id=" + id + ')');
                return done(null, false);
            }
            var sha = crypto.createHash('sha1'),
                hash = null;
            sha.update(client.client_id + ':' + secret + ':' + client.client_salt);
            try{
                hash = sha.digest('hex');
            }catch(ex){
                log('error', 'Exception while calculating client secret hash - ' + ex);
            }
            if (client.client_secret != hash){
                log('warn', "couldn't authenticate client with " + strategy_name + "Strategy: bad secret");
                return done(null, false);
            }
            log('debug', "authenticated client " + id + " with " + strategy_name + "Strategy");
            return done(null, client);
        });
    }
}

// BasicStrategy authenticates sites using HTTP Basic auth
passport.use(new BasicStrategy(client_id_auth('Basic')));

// ClientPasswordStrategy auths sites using details passed in the request body
passport.use(new ClientPasswordStrategy(client_id_auth('ClientPassword')));

// BearerStrategy
//
// This strategy is used to authenticate users based on an access token (aka a
// bearer token).  The user must have previously authorized a client
// application, which is issued an access token to make requests on behalf of
// the authorizing user.
passport.use(new BearerStrategy(
    function(accessToken, done){
        db.accessTokens.find(accessToken, function(err, token){
            if (err){
                return done(err);
            }
            if (!token){
                return done(null, false);
            }
      
            db.users.find(token.userID, function(err, user){
                log('notice', 'token ' + short_token(accessToken) + ' refs ' + (err ? 'invalid user' : user.id));
                if (err){
                    return done(err);
                }
                if (!user){
                    return done(null, false);
                }
                var info = { scope: token.scope, site_token: user.site_token };
                done(null, user, info);
            });
        });
    }
));

