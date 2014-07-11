var oauth2orize = require('oauth2orize'),
    passport = require('passport'),
    login = require('connect-ensure-login'),
    log = require('../lib/logging').log,
    config = require('../lib/config'),
    db = require('../db'),
    shorten = require('../lib/logging').format_sid,
    valid_scopes = require('../lib/resource_server').scopes,
    utils = require('../lib/utils');

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
        log('notice', 'Allocated code ' + shorten(code) + ' to ' + user.id);
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
    db.accessTokens.revoke(user.id, client.id, function(err){
        if (err){
            log('warn', 'Error revoking access token for user ' + userID + ' client ' + clientID + ': ' + err);
        }
        token = utils.uid(256);
        db.accessTokens.save(token, user.id, client.id, ares.scope, function(put_err){
            if (put_err){
                return done(put_err);
            }
            log('notice', 'Allocated token ' + shorten(token) + ' to ' + client.id + '.' + user.id);
            var params = {expires_in: db.accessTokens.expires_in() || 0};
            // Scope was validated earlier on.
            params.scope = ares.scope || ['basic'];
            done(null, token, params);
        });
    });
}));

// Allocate an access token and refresh token for the Auth Code Grant pattern.
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
            log('error', "Couldn't exchange code " + shorten(code) + ": " + err);
            return done(err);
        }
        var ok = true;
        if (!authCode){
            log('warn', "Couldn't exchange code " + shorten(code) + ' for client ' + client.id + ", invalid code");
            ok = false;
        }else if (client.id !== authCode.clientID){
            log('warn', "Couldn't exchange code " + shorten(code) + ' for client ' + client.id + ", actually allocated to client " + authCode.clientID);
            ok = false;
        }else if (client.allow_code_grant !== true){
            log('warn', "Couldn't exchange code " + shorten(code) + ' for client ' + client.id + ": config disabled");
            ok = false;
        }else if (redirectURI !== authCode.redirectURI){
            log('warn', "Couldn't exchange code " + shorten(code) + ' for client ' + client.id + ": bad redirect URI " + redirectURI);
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
                    log('notice', 'Deleted code ' + shorten(code) + ', no token issued.');
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

function valid_client(clientID, redirectURI, done){
    db.clients.findByClientId(clientID, function(err, client){
        if (err){
            return done(err);
        }
        if (!client){
            log('warn', 'Invalid redirect client ID ' + clientID);
            return done('Invalid client ID');
        }
        if (client.valid_redirects.indexOf(redirectURI) < 0 && client.valid_redirects.indexOf('*') < 0){
            log('warn', 'Invalid redirect URI for client ' + client.id + ' (' + client.client_id + ') - ' + redirectURI);
            return done('Invalid redirect URI ' + redirectURI);
        }
        return done(null, client, redirectURI);
    });
}

// Add a wrapper to handle the asynchronous loading of the redirect URL
var __ensureLoggedIn = undefined;
function ensureLoggedIn_wrapper(){
    if (!__ensureLoggedIn){
        __ensureLoggedIn = login.ensureLoggedIn(config.get('auth_server').url + '/login');
    }
    return __ensureLoggedIn.apply(this, arguments);
}

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
    ensureLoggedIn_wrapper,
    server.authorization(valid_client),
    function(req, res){
        var scope = [];
        if (!req.oauth2.req.scope || req.oauth2.req.scope.length < 1){
            scope = [valid_scopes()[0]];
            log('debug', 'No scope specified, using ' + scope[0]);
        }else{
            // validate listed scopes
            req.oauth2.req.scope.forEach(function(s){
                if (valid_scopes().indexOf(s) < 0){
                    s = valid_scopes()[0]; // side-effect: "*" defaults to smallest scope, not largest.
                }
                scope.push(s);
            });
            // remove duplicates
            scope = scope.reduce(function(prev, current){
                if (prev.indexOf(current) < 0){
                    prev.push(current);
                }
                return prev;
            }, []);
            log('debug', scope.length + ' scopes specified: ' + scope.join(', '));
        }
        req.oauth2.req.validated_scopes = scope;
        var v = config.get('auth_server').views.dialog;
        log('info', 'rendering ' + v + ' for TID ' + req.oauth2.transactionID);
        res.render(
            v,
            {
                transactionID: req.oauth2.transactionID,
                user: req.user,
                client: req.oauth2.client,
                scope: scope
            }
        );
    }
]

// user authorization review endpoint
//
// Based on the authorization endpoint above, this endpoint allows users to review
// the list of Clients that tokens have been granted to, and revoke as many of those
// tokens as they wish.
exports.authorization_review = [
    ensureLoggedIn_wrapper,
    function(req, res, next){
        if (!req.session){
            log('error', 'No session support found.');
            return next(new Error('Missing session support.'));
        }
        valid_client(req.query.client_id, req.query.redirect_uri, function(err, client, redirectURI){
            if (err){
                return next(new Error("Unauthorized Client"));
            }
            // We have to look at both access tokens and refresh tokens because
            // implicit grants only allocate access tokens.
            db.accessTokens.find_by_user(req.user.id, null, function(err, atoks){
                if (err){
                    log('error', 'Can\'t get access tokens for user ' + req.user.id);
                    return next(new Error("Internal error while searching for token grants"));
                }
                atoks = atoks || [];
                db.refreshTokens.find_by_user(req.user.id, null, function(err, rtoks){
                    if (err){
                        log('error', 'Can\'t get refresh tokens for user ' + req.user.id);
                        return next(new Error("Internal error while searching for token grants"));
                    }
                    rtoks = rtoks || [];
                    function render(err, details){
                        // TODO: Could really use a custom error page.
                        req.session['review'] = req.session['review'] || {};
                        details = details.map(function(d){
                            d.clientName = db.clients.name(d.clientID);
                            return d;
                        });
                        var tid = utils.uid(16);
                        req.session['review'][tid] = {
                            client: client.id,
                            redirectURI: redirectURI,
                            transactionID: tid,
                            grants: details
                        };
                        var v = config.get('auth_server').views.review;
                        log('info', 'rendering ' + v + ' for TID ' + shorten(tid));
                        res.render(
                            v,
                            {
                                transactionID: tid,
                                user: req.user,
                                client: {id: client.id, clientName: client.name},
                                grants: details
                            }
                        );
                    }
                    function load_tokens(type, list, next){
                        if (list && list.length){
                            db[type].find(list, function(err, details){
                                if (err){
                                    log('error', "Can't get refresh tokens for user " + req.user.id);
                                    return next(new Error("Internal error while searching for token grants"));
                                }
                                next(null, details);
                            });
                        }else{
                            next(null, []);
                        }
                    }
                    function force_array(a){
                        return Array.isArray(a) ? a : [a];
                    }
                    load_tokens('accessTokens', atoks, function(err, atok_details){
                        if (err){
                            return next(err);
                        }
                        load_tokens('refreshTokens', rtoks, function(err, rtok_details){
                            if (err){
                                return next(err);
                            }
                            atok_details = force_array(atok_details);
                            rtok_details = force_array(rtok_details);
                            var tokens = atok_details
                                            .concat(rtok_details)
                                            .filter(function(x, pos, xs){
                                                var dup = false;
                                                // this is shitty time complexity but the
                                                // lists will always be small.
                                                for (var i = pos+1; i < xs.length; ++i){
                                                    dup = dup || x.clientID === xs[i].clientID;
                                                }
                                                return !dup;
                                            });
                            render(null, tokens);
                        });
                    });
                });
            });
        });
    }
]

// user decision endpoint
//
// `decision` middleware processes a user's decision to allow or deny access
// requested by a client application.  Based on the grant type requested by the
// client, the above grant middleware configured above will be invoked to send
// a response.
exports.decision = [
    ensureLoggedIn_wrapper,
    server.decision(function(req, done){
        var userID = req.user.id,
            clientID = req.oauth2.client.id;
        if (req.body['cancel']){
            if (userID && clientID){
                log('notice', 'Revoking consent for ' + clientID + '.' + userID);
                db.refreshTokens.revoke(userID, clientID, function(err){
                    if (err){
                        return done(err);
                    }
                    db.accessTokens.revoke(userID, clientID, done);
                });
                return;
            }else{
                log('error', 'Can\'t revoke consent for ' + clientID + '.' + userID);
            }
        }
        if (req.oauth2.req.validated_scopes.join(' ') !== req.body['scope']){
            log('warn', '/authorization scope mismatch for user ' + userID + ' client ' + clientID +
                        ' (' + req.body['scope'] + ' vs. ' + req.oauth2.req.validated_scopes.join(', ') + ')');
            // In future it'd be nice to allow the POST to only approve a subset
            // of the requested scopes.
        }
        var scope = req.body['scope'] || valid_scopes()[0];
        scope = scope.split(/\s+/);
        log('debug', 'Consent ' + (req.body['cancel'] ? 'not ' : '') + 'granted for scopes ' + scope.join(', '));
        done(null, {scope: scope});
    })
]

// user decision update endpoint
//
// `decision` middleware for processing authorization_review interactions.
exports.decision_update = [
    ensureLoggedIn_wrapper,
    function(req, res, next){
        // Based on the oauth2orize transactionLoader middleware
        if (!req.session){
            log('error', 'No session support found.');
            return next(new Error('Missing session support.'));
        }
        var tid = req.body['transaction_id'];
        if (!tid){
            log('error', '/review POST missing transaction_id');
            return next(new Error('Missing required parameter transaction_id'));
        }
        var txn = req.session['review'][tid];
        if (!txn){
            log('error', '/review POST failed to load transaction context ' + shorten(tid));
            return next(new Error('Unable to load /review transaction ' + tid));
        }
        if (!txn.transactionID || !txn.client || !txn.redirectURI || !txn.grants){
            log('error', '/review POST loaded incomplete transaction context ' + shorten(tid));
            return next(new Error('Unable to load /review transaction ' + tid));
        }
        db.clients.find(txn.client, function(err, client){ // Usually done by server.deserializeClient()
            // Based on oauth2orize decision middleware
            if (err){
                log('error', "Couldn't load client " + txn.client + ': ' + err);
                return next(new Error('Unauthorized Client'));
            }
            if (!client){
                log('error', "No such client " + txn.client);
                return next(new Error('Unauthorized Client'));
            }
            txn.grants
                .reduce(function(to_remove, g){
                    if (req.body[g.clientID] !== 'on'){
                        to_remove.push(g);
                    }
                    return to_remove;
                }, [])
                .forEach(function(g){
                    db.refreshTokens.revoke(g.userID, g.clientID, function(err){
                        if (err){
                            log('warn', "Coudln't revoke refresh token for user " +
                                        g.userID + ' client ' + g.clientID + ': ' + err);
                        }
                        db.accessTokens.revoke(g.userID, g.clientID, function(err){
                            if (err){
                                log('warn', "Coudln't revoke access token for user " +
                                            g.userID + ' client ' + g.clientID + ': ' + err);
                            }
                        });
                    });
                });
            // TODO: go via a "flash" waypoint to show success/failure
            res.redirect(txn.redirectURI);
        });
    }
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
