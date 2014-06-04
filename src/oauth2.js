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
    db.authorizationCodes.save(code, client.id, redirectURI, user.id, ares.scope, function(err){
        if (err){
            log('error', "Couldn't save authorization code " + shorten(code) + ': ' + err);
            return done(err);
        }
        log('notice', 'allocated code ' + shorten(code) + ' to ' + user.id);
        done(null, code);
    });
}));

// Implicit Token Grant.  The callback takes the `client` requesting
// authorization, the authenticated `user` granting access, and
// their response. The application issues an access token.
//
// TRY NOT TO USE THIS. (i.e. negotiate hard before setting allow_implicit_grant=true.)
// Because the access token is returned via the User Agent it's more easily captured.
// Capturing the token for user Alice allows you to log in to ANY other client site
// that uses the implicit grant pattern as though you were Alice.
// With the Auth Code Grant pattern you're still open to this kind of attack from
// malicious Clients, but not from compromised User Agents.

server.grant(oauth2orize.grant.token(function(client, user, ares, done){
    if (client.allow_implicit_grant !== true){
        log('warn', 'Implicit grant not allowed for client ' + client.id + ' (' + client.client_id + ')');
        return done('Implicit Grant not allowed for this Client');
    }
    db.accessTokens.revoke(user, client, function(err){
        if (err){
            log('warn', 'Error revoking access token for user ' + userID + ' client ' + clientID + ': ' + err);
        }
        token = utils.uid(256);
        db.accessTokens.save(token, user.id, client.id, ares.scope, function(put_err){
            if (put_err){
                return done(put_err);
            }
            log('notice', 'allocated token ' + shorten(token) + ' to ' + client.id + '.' + user.id);
            var params = {expires_in: db.accessTokens.expires_in() || 0};
            // Scope was validated earlier on.
            params.scope = ares.scope || ['basic'];
            done(null, token, params);
        });
    });
}));

// Allocate an access token and refresh token.
// The existing tokens will always be revoked if they exist.
function allocate_and_save_token(userID, clientID, scope, done){
    db.accessTokens.revoke(userID, clientID, function(err){
        if (err){
            log('warn', 'Error revoking access token for user ' + userID + ' client ' + clientID + ': ' + err);
        }
        db.refreshTokens.revoke(userID, clientID, function(err){
            if (err){
                log('warn', 'Error revoking refresh token for user ' + userID + ' client ' + clientID + ': ' + err);
            }
            // Our tokens are opaque handle-type tokens, which are easier to revoke
            // than assertion-type tokens. The down side is that they don't scale as well
            // because they require communication between the auth server and resource
            // server.
            // That fits with the current architecture, but YMMV.
            var token = utils.uid(256);
            db.accessTokens.save(token, userID, clientID, scope, function(err){
                if (err){
                    log('error', 'Failed to allocate access token ' + shorten(token) + ' for user ' + userID + ' client ' + clientID + ': ' + err);
                    return done(err);
                }
                log('info', 'Allocated token ' + shorten(token) + ' for user ' + userID + ' client ' + clientID);
                var refreshToken = utils.uid(256);
                db.refreshTokens.save(refreshToken, userID, clientID, scope, function(err){
                    if (err){
                        log('error', 'Failed to allocate refresh token ' + shorten(refreshToken) + ' for user ' + userID + ' client ' + clientID + ': ' + err);
                        // Continue down the success path, just minus a refresh token.
                        refreshToken = null;
                    }else{
                        log('info', 'Allocated refresh token ' + shorten(refreshToken) + ' for user ' + userID + ' client ' + clientID);
                    }
                    var params = {expires_in: db.accessTokens.expires_in() || 0};
                    // Scope was validated earlier on.
                    params.scope = scope || ['basic'];
                    return done(null, token, refreshToken, params);
                });
            });
        });
    });
}


// Exchange a refresh token for a new access token and refresh token.
// Refresh tokens (like authentication codes) are always one-time use items.
// The point of a refresh token is that you can force access tokens to expire
// regularly, but also give the client a way of getting a new token without
// user intervention.
// Expiring tokens regularly is good because if a token is compromised then
// the window in which bad stuff can happen is shorter.
// If the entire Client DB is compromised, i.e. access tokens AND refresh
// tokens, then the one-time-use nature of refresh tokens gives you a hint
// that something bad is going on.

server.exchange(oauth2orize.exchange.refreshToken(function(client, refreshToken, done){
    db.refreshTokens.find(refreshToken, function(err, rtok){
        if (err){
            log('error', "Couldn't use refresh token " + shorten(refreshToken) + ": " + err);
            return done(err);
        }
        var ok = true;
        if (!rtok){
            log('warn', "Couldn't use refresh token " + shorten(refreshToken) + ' for client ' + client.id + ", invalid token");
            ok = false;
        }else if (client.id !== rtok.clientID){
            log('warn', "Couldn't use refresh token " + shorten(refreshToken) + ' for client ' + client.id + " (actually allocated to " + rtok.clientID + ')');
            ok = false;
        }else if (client.allow_code_grant !== true){
            log('warn', "Couldn't use refresh token " + shorten(refreshToken) + ' for client ' + client.id + ", config disabled");
            ok = false;
        }
        if (!ok){
            if (rtok){
                db.refreshTokens.del(refreshToken, function(err){
                    if (err){
                        log('error', 'Failed to delete tainted refresh token ' + shorten(refreshToken));
                        return done(err);
                    }
                    log('notice', 'Deleted refresh token ' + shorten(refreshToken) + ', no token issued.');
                    done(null, false);
                });
            }else{
                log('debug', 'No refresh token to revoke.');
                done(null, false);
            }
            return;
        }
        allocate_and_save_token(rtok.userID, rtok.clientID, rtok.scope, function(err, token, newRefreshToken, params){
            if (err){
                log('error', "Couldn't use refresh token " + shorten(refreshToken) + ': ' + err);
                return done(err);
            }
            log('notice', 'Exchanged refresh token ' + shorten(refreshToken) + ' for AT ' + shorten(token) + '/RT ' + shorten(newRefreshToken));
            done(null, token, newRefreshToken, params);
        });
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
            log('error', "couldn't exchange code " + shorten(code) + ": " + err);
            return done(err);
        }
        var ok = true;
        if (!authCode){
            log('warn', "couldn't exchange code " + shorten(code) + ' for client ' + client.id + ", invalid code");
            ok = false;
        }else if (client.id !== authCode.clientID){
            log('warn', "couldn't exchange code " + shorten(code) + ' for client ' + client.id + ", actually allocated to client " + authCode.clientID);
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
                db.authorizationCodes.del(code, function(err){
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

        db.authorizationCodes.del(code, function(err){
            if(err){
                return done(err);
            }
            allocate_and_save_token(authCode.userID, authCode.clientID, authCode.scope, function(err, token, refresh, params){
                if (err){
                    log('error', 'Failed to exchange code ' + shorten(code) + ' for a token: ' + err);
                    return done(err);
                }
                log('notice', 'Exchanged code ' + shorten(code) + ' for AT ' + shorten(token) + '/RT ' + shorten(refresh));
                done(null, token, refresh, params);
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
                client: req.oauth2.client,
                scope: req.oauth2.req.scope || [] // TODO: validate scope
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
        // TODO: validate scope
        var scope = req.body['scope'] || 'basic';
        done(null, {scope: scope.split(' ')});
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
