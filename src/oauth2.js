var oauth2orize = require('oauth2orize'),
    passport = require('passport'),
    login = require('connect-ensure-login'),
    log = require('../lib/logging').log,
    config = require('../lib/config'),
    db = require('../db'),
    shorten = require('../lib/logging').format_sid,
    utils = require('../lib/utils');

// TODO: Any time we want to deny access we must call done(null, false) rather than done(err).
var server = oauth2orize.createServer();

// Register serialialization and deserialization functions.
//
// When a client redirects a user to user authorization endpoint, an
// authorization transaction is initiated.  To complete the transaction, the
// user must authenticate and approve the authorization request.  Because this
// may involve multiple HTTP request/response exchanges, the transaction is
// stored in the session.
//
// An application must supply serialization functions, which determine how the
// client object is serialized into the session.  Typically this will be a
// simple matter of serializing the client's ID, and deserializing by finding
// the client by ID from the database.

server.serializeClient(function(client, done){
    return done(null, client.id);
});

server.deserializeClient(function(id, done){
    db.clients.find(id, function(err, client){
        if (err){
            return done(err);
        }
        return done(null, client);
    });
});

// Register supported grant types.
//
// OAuth 2.0 specifies a framework that allows users to grant client
// applications limited access to their protected resources.  It does this
// through a process of the user granting access, and the client exchanging
// the grant for an access token.

// Authorization Code Grant.  The callback takes the `client` requesting
// authorization, the `redirectURI` (which is used as a verifier in the
// subsequent exchange), the authenticated `user` granting access, and
// their response, which contains approved scope, duration, etc. as parsed by
// the application.  The application issues a code, which is bound to these
// values, and will be exchanged for an access token.

server.grant(oauth2orize.grant.code(function(client, redirectURI, user, ares, done){
    if (client.allow_code_grant !== true){
        log('warn', 'Code grant not allowed for client ' + client.id + ' (' + client.client_id + ')');
        return done('Authorization Code Grant not allowed for this Client');
    }

    var code = utils.uid(16)
    db.authorizationCodes.save(code, client.id, redirectURI, user.id, function(err){
        if (err){
            return done(err);
        }
        log('notice', 'allocated code ' + shorten(code) + ' to ' + user.id);
        done(null, code);
    });
}));

// Implicit Token Grant.  The callback takes the `client` requesting
// authorization, the authenticated `user` granting access, and
// their response. The application issues an access token.

server.grant(oauth2orize.grant.token(function(client, user, ares, done){
    if (client.allow_implicit_grant !== true){
        log('warn', 'Implicit grant not allowed for client ' + client.id + ' (' + client.client_id + ')');
        return done('Implicit Grant not allowed for this Client');
    }
    db.accessTokens.find_by_user(user.id, client.id, function(err, token){
        if (err){
            log('error', 'Error while looking up token for ' + client.id + '.' + user.id + ' - ' + err);
            // But carry on anyway...
        }
        if (token){
            log('notice', 'retrieved token ' + shorten(token) + ' for ' + client.id + '.' + user.id);
            done(null, token);
        }else{
            log('info', 'No existing token for ' + client.id + '.' + user.id);
            token = utils.uid(256);
            db.accessTokens.save(token, user.id, client.id, function(put_err){
                if (put_err){
                    return done(put_err);
                }
                log('notice', 'allocated token ' + shorten(token) + ' to ' + client.id + '.' + user.id);
                done(null, token);
            });
        }
    });
}));


// Exchange authorization codes for access tokens.  The callback accepts the
// `client`, which is exchanging `code` and any `redirectURI` from the
// authorization request for verification.  If these values are validated, the
// application issues an access token on behalf of the user who authorized the
// code.

server.exchange(oauth2orize.exchange.code(function(client, code, redirectURI, done){
    db.authorizationCodes.find(code, function(err, authCode){
        if (err){
            log('warn', "couldn't exchange code " + shorten(code) + ": " + err);
            return done(err);
        }
        var ok = true;
        if (!authCode){
            log('warn', "couldn't exchange code " + shorten(code) + ' for client ' + client.id + ", invalid code");
            ok = false;
        }else if (client.id !== authCode.clientID){
            log('warn', "couldn't exchange code " + shorten(code) + ' for client ' + client.id + ", that code is allocated to client " + authCode.clientID);
            ok = false;
        }else if (client.allow_code_grant !== true){
            log('warn', "couldn't exchange code " + shorten(code) + ' for client ' + client.id + ": config disabled");
            ok = false;
        }else if (redirectURI !== authCode.redirectURI){
            log('warn', "couldn't exchange code " + shorten(code) + ' for client ' + client.id + ": bad redirect URI " + redirectURI);
            ok = false;
        }
        if (!ok){
            if (authCode){
                // revoke code for bad behaviour
                db.authorizationCodes.delete(code, function(err){
                    if (err){
                        log('error', 'Failed to delete tainted code ' + shorten(code));
                        return done(err);
                    }
                    log('notice', 'deleted code ' + shorten(code) + ', no token issued.');
                    done(null, false);
                });
            }else{
                log('debug', 'No code to revoke.');
                done(null, false);
            }
            return;
        }

        db.authorizationCodes.delete(code, function(err){
            if(err){
                return done(err);
            }
            var token = utils.uid(256);
            db.accessTokens.save(token, authCode.userID, authCode.clientID, function(err){
                if (err){
                    log('error', 'Failed to save new token ' + shorten(token) + ' for code ' + shorten(code));
                    return done(err);
                }
                log('notice', 'exchanged code ' + shorten(code) + ' for token ' + shorten(token));
                done(null, token);
            });
        });
    });
}));



// user authorization endpoint
//
// `authorization` middleware accepts a `validate` callback which is
// responsible for validating the client making the authorization request.  In
// doing so, is recommended that the `redirectURI` be checked against a
// registered value, although security requirements may vary accross
// implementations.  Once validated, the `done` callback must be invoked with
// a `client` instance, as well as the `redirectURI` to which the user will be
// redirected after an authorization decision is obtained.
//
// This middleware simply initializes a new authorization transaction.  It is
// the application's responsibility to authenticate the user and render a dialog
// to obtain their approval (displaying details about the client requesting
// authorization).  We accomplish that here by routing through `ensureLoggedIn()`
// first, and rendering the `dialog` view. 

exports.authorization = [
    login.ensureLoggedIn(),
    server.authorization(function(clientID, redirectURI, done){
        db.clients.findByClientId(clientID, function(err, client){
            if (err){
                return done(err);
            }
            if (!client){
                log('warn', 'Invalid redirect client ID ' + clientID);
                return done('Invalid client ID');
            }
            if (client.valid_redirects.indexOf(redirectURI) < 0){
                log('warn', 'Invalid redirect URI for client ' + client.id + ' (' + client.client_id + ') - ' + redirectURI);
                return done('Invalid redirect URI ' + redirectURI);
            }
            return done(null, client, redirectURI);
        });
    }),
    function(req, res){
        res.render(
            config.get('auth_server').views.dialog,
            {
                transactionID: req.oauth2.transactionID,
                user: req.user,
                client: req.oauth2.client
            }
        );
    }
]

// user decision endpoint
//
// `decision` middleware processes a user's decision to allow or deny access
// requested by a client application.  Based on the grant type requested by the
// client, the above grant middleware configured above will be invoked to send
// a response.

exports.decision = [
    login.ensureLoggedIn(),
    server.decision(function(req, done){
        if (req.body['cancel']){
            var userID = req.user.id,
                clientID = req.oauth2.client.id;
            if (userID && clientID){
                log('notice', 'Revoking consent for ' + clientID + '.' + userID);
                return db.accessTokens.revoke(userID, clientID, done);
            }else{
                log('error', 'Can\'t revoke consent for ' + clientID + '.' + userID);
            }
        }
        done();
    })
]


// token endpoint
//
// `token` middleware handles client requests to exchange authorization grants
// for access tokens.  Based on the grant type being exchanged, the above
// exchange middleware will be invoked to handle the request.  Clients must
// authenticate when making requests to this endpoint.

exports.token = [
    passport.authenticate(['basic', 'oauth2-client-password'], { session: false }),
    server.token(),
    server.errorHandler()
]
