var sa      = require('superagent'),
    assert  = require('assert'),
    log     = require('../lib/logging'),
    config  = require('../lib/config'),
    should  = require('should');

var host;
config.defer(function(err, conf){
    host = (conf.auth_server.ssl ? 'https' : 'http') +
            '://' + conf.auth_server.hostname + ':' + conf.auth_server.port
});

function make_user(){
    return {
        a: sa.agent()
    };
};

var good_password = 'password',
    bad_password = 'abc123';

function get_json(t){
    var j = false;
    try{
        j = JSON.parse(t);
    }catch(ex){
    }
    return j;
}

var validate = {
    challenge: function(u, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(200);
            (!res.redirects).should.be.false;
            res.redirects[0].should.equal(host + '/login');
            var sid_match = res.headers['set-cookie'].toString().match(/sid=([^;]+)/);
            (null !== sid_match).should.be.true;
            u.sid = sid_match[1];
            done();
        }
    },
    login_failed_bad_password: function(u, sp_link_params, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(200);
            // TODO
            done();
        }
    },
    login_failed_bad_client: function(u, sp_link_params, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(500);
            done();
        }
    },
    requesting_consent_no_redirect: function(u, sp_link_params, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(200);
            (!res.redirects).should.be.false;
            res.redirects.length.should.equal(0);
            var sid_match = res.headers['set-cookie'].toString().match(/sid=([^;]+)/);
            (null !== sid_match).should.be.true;
            u.sid.should.equal(sid_match[1]);
            var txn = res.text.match(/transaction_id.*?value="([^"]+)/);
            (!txn).should.be.false;
            u.txn = txn[1];
            done();
        }
    },
    requesting_consent_after_redirect: function(u, sp_link_params, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(200);
            (!res.redirects).should.be.false;
            res.redirects[0].should.equal(host + '/authorize?' + sp_link_params);
            var sid_match = res.headers['set-cookie'].toString().match(/sid=([^;]+)/);
            (null !== sid_match).should.be.true;
            u.sid.should.equal(sid_match[1]);
            var txn = res.text.match(/transaction_id.*?value="([^"]+)/);
            (!txn).should.be.false;
            u.txn = txn[1];
            done();
        }
    },
    consent_denied: function(u, sp_redirect_uri, done){
        return function(err, res){
            delete u.txn;
            should.not.exist(err);
            res.should.have.status(302);
            (!res.redirects).should.be.false;
            var redir = res.headers['location'];
            (!redir).should.be.false;
            redir.should.equal(sp_redirect_uri);
            var sid_match = res.headers['set-cookie'].toString().match(/sid=([^;]+)/);
            (null !== sid_match).should.be.true;
            u.sid.should.equal(sid_match[1]);
            done();
        }
    },
    consent_denied_no_tid: function(u, sp_redirect_uri, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(500); // Hrm. Questionable status.
            done();
        }
    },
    code_granted: function(u, sp_redirect_uri, done){
        return function(err, res){
            delete u.txn;
            should.not.exist(err);
            res.should.have.status(302);
            (!res.redirects).should.be.false;
            var redir = res.headers['location'].match(/(.*)?\?code=([^&]+)(&state=.*)?/);
            (!redir).should.be.false;
            u.code = redir[2];
            (sp_redirect_uri.match(new RegExp(redir[3])) !== null).should.be.true;
            var sid_match = res.headers['set-cookie'].toString().match(/sid=([^;]+)/);
            (null !== sid_match).should.be.true;
            u.sid.should.equal(sid_match[1]);
            done();
        }
    },
    token: function(u, done, keep_code, scope){
        return function(err, res){
            if (keep_code){
                // Don't delete code yet; we want to check it can't be used twice.
            }else{
                delete u.code;
            }
            should.not.exist(err);
            res.should.have.status(200);
            var j = get_json(res.text);
            j.should.be.ok;
            j.access_token.should.be.ok;
            j.expires_in.should.be.ok;
            (j.expires_in > 0).should.be.true;
            (j.expires_in < 60*60*24*365).should.be.true;
            if (scope){
                should.exist(j.scope);
                var ss = j.scope.join(' ');
                ss.should.equal(scope);
            }
            u.token = j.access_token;
            u.refresh_token = j.refresh_token;
            j.token_type.should.equal('Bearer');
            done();
        }
    },
    token_err_bad_client: function(u, done){
        return function(err, res){
            should.not.exist(err);
            (res.statusCode === 401 || res.statusCode === 403).should.be.ok;
            done();
        }
    },
    token_err_bad_refresh_token: function(u, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(403);
            var j = get_json(res.text);
            should.exist(j.error);
            j.error.should.equal('invalid_grant');
            j.error_description.should.equal('Invalid refresh token');
            done();
        }
    },
    token_err_bad_code: function(u, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(403);
            var j = get_json(res.text);
            should.exist(j.error);
            j.error.should.equal('invalid_grant');
            j.error_description.should.equal('Invalid authorization code');
            done();
        }
    },
    api_access: function(u, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(200);
            res.text.should.be.ok;
            var j = false;
            try{
                j = JSON.parse(res.text);
            }catch(ex){
                should.not.exist(ex);
            }
            j.should.be.ok;
            should.exist(j.id);
            done();
        }
    },
    api_write_success: function(u, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(200);
            res.text.should.be.ok;
            var j = false;
            try{
                j = JSON.parse(res.text);
            }catch(ex){
                should.not.exist(ex);
            }
            j.should.be.ok;
            should.exist(j.success);
            (j.success === 1).should.be.true;
            done();
        }
    },
    api_bad_scope: function(u, done){
        return function(err, res){
            res.should.have.status(403);
            res.text.should.be.ok;
            var j = false;
            try{
                j = JSON.parse(res.text);
            }catch(ex){
                should.not.exist(ex);
            }
            j.should.be.ok;
            (j.success === 0).should.be.true;
            should.exist(j.error);
            j.error.should.equal('insufficient scope');
            done();
        }
    },
    api_bad_function: function(u, done){
        return function(err, res){
            res.should.have.status(404);
            res.text.should.be.ok;
            var j = false;
            try{
                j = JSON.parse(res.text);
            }catch(ex){
                should.not.exist(ex);
            }
            j.should.be.ok;
            (j.success === 0).should.be.true;
            should.exist(j.error);
            j.error.should.equal('no such function');
            done();
        }
    },
    api_err_bad_token: function(u, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(401);
            done();
        }
    }
};

function client_details(name, uri, state, scope){
    uri = uri || 'http://localhost:8080/';
    name = name || 'test';
    return {
        uri: uri,
        params: 'response_type=code' +
                '&client_id=' + encodeURIComponent(name) +
                '&redirect_uri=' + encodeURIComponent(uri) +
                (state ? '&state=' + encodeURIComponent(state) : '') +
                (scope ? '&scope=' + encodeURIComponent(scope) : ''),
        state: state,
        scope: scope
    };
}

describe('code grant front channel', function(){
    var c = client_details('test'),
        u1 = null;

    describe('/login', function(){
        u1 = make_user();

        it('should be triggered when no session exists', function(done){
            u1.a.get(host + '/authorize?' + c.params)
                .end(validate.challenge(u1, done));
        });
        it('should fail on bad password', function(done){
            u1.a.post(host + '/login')
                .send({username: 'catalyst.tester@gmail.com.x', password: bad_password})
                .end(validate.login_failed_bad_password(u1, c.params, done));
        });
        it('should fail on bad client ID', function(done){
            var bad_c = client_details('XXX');
            var u2 = make_user();
            u2.a.get(host + '/authorize?' + bad_c.params)
                .end(validate.challenge(u2, function(){
                    u2.a.post(host + '/login')
                        .send({username: 'ittesters@hotmail.co.nz.x', password: good_password})
                        .end(validate.login_failed_bad_client(u2, bad_c.params, done));
                }));
        });
        it('should succeed on good password', function(done){
            u1.a.post(host + '/login')
                .send({username: 'catalyst.tester@gmail.com.x', password: good_password})
                .end(validate.requesting_consent_after_redirect(u1, c.params, done));
        });
        var otxn = null;
        it('should remember auth state', function(done){
            should.exist(u1.txn);
            otxn = u1.txn;
            u1.a.get(host + '/authorize?' + c.params)
                .end(validate.requesting_consent_no_redirect(u1, c.params, done));
        });
        it('should have generated a new transaction ID', function(){
            should.exist(u1.txn);
            otxn.should.not.equal(u1.txn);
        });
    });
    describe('/authorize', function(){
        it('denying consent should redirect back to client', function(done){
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn, cancel: 'Deny'})
                .redirects(0) // don't follow any redirects
                .end(validate.consent_denied(u1, c.uri + '?error=access_denied', done));
        });
        it('should still be authenticated', function(done){
            u1.a.get(host + '/authorize?' + c.params + '&state=foo')
                .end(validate.requesting_consent_no_redirect(u1, c.params, done));
        });
        it('should preserve state param on failure redirect', function(done){
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn, cancel: 'Deny'})
                .redirects(0)
                .end(validate.consent_denied(u1, c.uri + '?error=access_denied' + '&state=foo', done));
        });
        it('should not allow transaction IDs to be reused after failure', function(done){
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn})
                .redirects(0)
                .end(validate.consent_denied_no_tid(u1, c.params + '&state=foo', done));
        });
        it('should still be authenticated', function(done){
            u1.a.get(host + '/authorize?' + c.params + '&state=foo')
                .end(validate.requesting_consent_no_redirect(u1, c.params, done));
        });
        it('should grant code on user consent', function(done){
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn})
                .redirects(0)
                .end(validate.code_granted(u1, c.params + '&state=foo', done));
        });
        it('should still be authenticated', function(done){
            u1.a.get(host + '/authorize?' + c.params)
                .end(validate.requesting_consent_no_redirect(u1, c.params, done));
        });
        it('should allow another code to be granted', function(done){
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn})
                .redirects(0)
                .end(validate.code_granted(u1, c.params, done));
        });
    });
});

describe('code grant back channel', function(){
    var c = client_details('test'),
        u1 = null;

    function grant_initial_code(uN, username, client){
        client = client || c;
        return function(done){
            uN.a.get(host + '/authorize?' + client.params)
                .end(validate.challenge(uN, function(){
                    uN.a.post(host + '/login')
                        .send({username: username, password: good_password})
                        .end(validate.requesting_consent_after_redirect(uN, client.params, function(){
                            uN.a.post(host + '/authorize')
                                .send({transaction_id: uN.txn, scope: client.scope})
                                .redirects(0)
                                .end(validate.code_granted(uN, client.params, done));
                        }))
                }))
        }
    }
    function grant_subsequent_code(uN, client){
        client = client || c;
        return function(done){
            uN.a.get(host + '/authorize?' + client.params)
                .end(validate.requesting_consent_no_redirect(uN, client.params, function(){
                    uN.a.post(host + '/authorize')
                        .send({transaction_id: uN.txn, scope: client.scope})
                        .redirects(0)
                        .end(validate.code_granted(uN, client.params, done));
                }))
        }
    }

    describe('/token', function(){
        u1 = make_user();

        it('should grant initial code', grant_initial_code(u1, 'catalyst.tester@gmail.com.x'));
        it('should fail to exchange code for token with valid-but-mismatched client ID', function(done){
            make_user().a.post(host + '/token')
                         .auth('sp-demo', 'hunter2')
                         .send({
                            grant_type: 'authorization_code',
                            code: u1.code,
                            redirect_uri: c.uri
                         })
                         .end(validate.token_err_bad_client(null, done));
        });
        it('should fail to exchange code for token (one use only)', function(done){
            make_user().a.post(host + '/token')
                         .auth('test', 'hunter2')
                         .send({
                            grant_type: 'authorization_code',
                            code: u1.code,
                            redirect_uri: c.uri
                         })
                         .end(validate.token_err_bad_code(null, done));
        });
        it('should get a new code', grant_subsequent_code(u1));
        it('should exchange code for token', function(done){
            make_user().a.post(host + '/token')
                         // side-effect: test BasicStrategy by putting creds in the header
                         .auth('test', 'hunter2')
                         .send({
                            grant_type: 'authorization_code',
                            code: u1.code,
                            redirect_uri: c.uri
                         })
                         .end(validate.token(u1, done, true));
        });
        it('should allow API access', function(done){
            make_user().a.get(host + '/api/profile')
                         .set('Authorization', 'Bearer ' + u1.token)
                         .end(validate.api_access(u1, done));
        });
        it('should fail to exchange code for token (one use only)', function(done){
            make_user().a.post(host + '/token')
                         .auth('test', 'hunter2')
                         .send({
                            grant_type: 'authorization_code',
                            code: u1.code,
                            redirect_uri: c.uri
                         })
                         .end(validate.token_err_bad_code(null, done));
        });
        it('should get a new code', grant_subsequent_code(u1));
        var old_token;
        it('should exchange code for token', function(done){
            old_token = u1.token;
            make_user().a.post(host + '/token')
                         .send({
                            grant_type: 'authorization_code',
                            code: u1.code,
                            redirect_uri: c.uri,
                            // side-effect: test ClientPasswordStrategy by putting creds in the body
                            client_id: 'test',
                            client_secret: 'hunter2'
                         })
                         .end(validate.token(u1, done, true));
        });
        it('should have issued a different token', function(){
            should.exist(u1.token);
            old_token.should.not.equal(u1.token);
        });
        it('should NOT allow API access (old token)', function(done){
            make_user().a.get(host + '/api/profile')
                         .set('Authorization', 'Bearer ' + old_token)
                         .end(validate.api_err_bad_token(u1, done));
        });
        it('should allow API access (new token)', function(done){
            make_user().a.get(host + '/api/profile')
                         .set('Authorization', 'Bearer ' + u1.token)
                         .end(validate.api_access(u1, done));
        });
    });

    describe('explicit scopes', function(){
        var u3 = make_user(),
            c2 = client_details('test', null, null, 'read-only');

        it('should grant initial code', grant_initial_code(u3, 'bob@example.com', c2));
        it('should exchange code for token', function(done){
            make_user().a.post(host + '/token')
                         .auth('test', 'hunter2')
                         .send({
                            grant_type: 'authorization_code',
                            code: u3.code,
                            redirect_uri: c2.uri
                         })
                         .end(validate.token(u3, done, true, c2.scope));
        });
        it('should allow read-only access', function(done){
            make_user().a.get(host + '/api/profile')
                         .set('Authorization', 'Bearer ' + u3.token)
                         .end(validate.api_access(u3, done));
        });
        it('should not allow write access', function(done){
            make_user().a.get(host + '/api/update_avatar')
                         .set('Authorization', 'Bearer ' + u3.token)
                         .end(validate.api_bad_scope(u3, done));
        });
        it('should not allow access to missing functions', function(done){
            make_user().a.get(host + '/api/cheese')
                         .set('Authorization', 'Bearer ' + u3.token)
                         .end(validate.api_bad_function(u3, done));
        });
    });

    describe('multiple scopes', function(){
        var u4 = make_user(),
            c3 = client_details('test', null, null, 'read-only read-write');

        it('should grant initial code', grant_initial_code(u4, 'bob@example.com', c3));
        it('should exchange code for token', function(done){
            make_user().a.post(host + '/token')
                         .auth('test', 'hunter2')
                         .send({
                            grant_type: 'authorization_code',
                            code: u4.code,
                            redirect_uri: c3.uri
                         })
                         .end(validate.token(u4, done, true, c3.scope));
        });
        it('should allow read-only access', function(done){
            make_user().a.get(host + '/api/profile')
                         .set('Authorization', 'Bearer ' + u4.token)
                         .end(validate.api_access(u4, done));
        });
        it('should allow write access', function(done){
            make_user().a.get(host + '/api/update_avatar')
                         .set('Authorization', 'Bearer ' + u4.token)
                         .end(validate.api_write_success(u4, done));
        });
        it('should not allow access to missing functions', function(done){
            make_user().a.get(host + '/api/cheese')
                         .set('Authorization', 'Bearer ' + u4.token)
                         .end(validate.api_bad_function(u4, done));
        });
    });

    // These tests are separate from plain old access tokens because it's conceivable that you
    // might want to cut out this functionality without breaking all of the other tests.
    describe('/token (refresh)', function(){
        var old_tok,
            old_reftok;
        it('should grant new code', grant_subsequent_code(u1));
        it('should exchange code for token', function(done){
            old_tok = u1.token;
            old_reftok = u1.refresh_token;
            make_user().a.post(host + '/token')
                         .send({
                            grant_type: 'authorization_code',
                            code: u1.code,
                            redirect_uri: c.uri,
                            // side-effect: test ClientPasswordStrategy by putting creds in the body
                            client_id: 'test',
                            client_secret: 'hunter2'
                         })
                         .end(validate.token(u1, done, true));
        });
        it('should have issued a different refresh token', function(){
            should.exist(u1.refresh_token);
            old_reftok.should.not.equal(u1.refresh_token);
        });
        it('should allow refresh token to be redeemed', function(done){
            old_tok = u1.token;
            old_reftok = u1.refresh_token;
            make_user().a.post(host + '/token')
                         .auth('test', 'hunter2')
                         .send({
                             grant_type: 'refresh_token',
                             refresh_token: u1.refresh_token
                         })
                         .end(validate.token(u1, done, true));
        });
        it('should have changed both tokens again', function(){
            should.exist(u1.token);
            old_tok.should.not.equal(u1.token);
            should.exist(u1.refresh_token);
            old_reftok.should.not.equal(u1.refresh_token);
        });
        it('should not allow old refresh token to be used again', function(done){
            make_user().a.post(host + '/token')
                         .auth('test', 'hunter2')
                         .send({
                             grant_type: 'refresh_token',
                             refresh_token: old_reftok
                         })
                         .end(validate.token_err_bad_refresh_token(u1, done, true));
        });
        it('should not allow API access for old token', function(done){
            make_user().a.get(host + '/api/profile')
                         .set('Authorization', 'Bearer ' + old_tok)
                         .end(validate.api_err_bad_token(u1, done));
        });
        it('should allow API access for new token', function(done){
            make_user().a.get(host + '/api/profile')
                         .set('Authorization', 'Bearer ' + u1.token)
                         .end(validate.api_access(u1, done));
        });
        it('should allow refresh token to be redeemed', function(done){
            make_user().a.post(host + '/token')
                         .auth('test', 'hunter2')
                         .send({
                             grant_type: 'refresh_token',
                             refresh_token: u1.refresh_token
                         })
                         .end(validate.token(u1, done, true));
        });
    });
});

