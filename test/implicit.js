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
            decodeURIComponent(res.redirects[0]).should.equal(host + '/authorize?' + sp_link_params);
            var sid_match = res.headers['set-cookie'].toString().match(/sid=([^;]+)/);
            (null !== sid_match).should.be.true;
            u.sid.should.equal(sid_match[1]);
            var txn = res.text.match(/transaction_id.*?value="([^"]+)/);
            (!txn).should.be.false;
            u.txn = txn[1];
            done();
        }
    },
    consent: function(u, sp_link_params, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(200);
            (!res.redirects).should.be.false;
            decodeURIComponent(res.redirects[0]).should.equal(host + '/authorize?' + sp_link_params);
            var sid_match = res.headers['set-cookie'].toString().match(/sid=([^;]+)/);
            (null !== sid_match).should.be.true;
            u.sid.should.equal(sid_match[1]);
            var txn = res.text.match(/transaction_id.*?value="([^"]+)/);
            (!txn).should.be.false;
            u.txn = txn[1];
            done();
        }
    },
    consent_already_logged_in: function(u, sp_link_params, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(200);
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
    no_token: function(u, sp_redirect_uri, done){
        return function(err, res){
            delete u.txn;
            should.not.exist(err);
            res.should.have.status(302);
            (!res.redirects).should.be.false;
            var redir = res.headers['location'].match(/(.*)#error=access_denied$/);
            (!redir).should.be.false;
            redir[1].should.equal(sp_redirect_uri);
            var sid_match = res.headers['set-cookie'].toString().match(/sid=([^;]+)/);
            (null !== sid_match).should.be.true;
            u.sid.should.equal(sid_match[1]);
            done();
        }
    },
    token: function(u, sp_redirect_uri, scope, state, done){
        return function(err, res){
            delete u.txn;
            should.not.exist(err);
            res.should.have.status(302);
            (!res.redirects).should.be.false;
            var pattern = sp_redirect_uri + '#access_token=([^&]+)' +
                                            '&expires_in=\\d+' +
                                            (scope ? '&scope=' + scope : '') +
                                            '&token_type=Bearer' +
                                            (state ? '&state=' + state : '') +
                                            '$'; // Note: implicit grant may never include a refresh token.
            var redir = res.headers['location'].match(new RegExp(pattern));
            (!redir).should.be.false;
            u.token = redir[1];
            var sid_match = res.headers['set-cookie'].toString().match(/sid=([^;]+)/);
            (null !== sid_match).should.be.true;
            u.sid.should.equal(sid_match[1]);
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
    api_access_failed_bad_token: function(u, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(401);
            var h = res.headers['www-authenticate'];
            (h && h.match(/invalid_token/)).should.be.ok;
            (!res.clientError).should.be.false;
            done();
        }
    }
};

function client_details(name, uri, state, scope){
    uri = uri || 'http://localhost:8080/';
    name = name || 'test';
    return {
        uri: uri,
        params: encodeURI('response_type=token&client_id=' + name +
                          '&redirect_uri=' + uri +
                          (state ? '&state=' + state : '') +
                          (scope ? '&scope=' + scope : '')),
        state: state,
        scope: scope
    };
}

describe('implicit grant', function(){
    var c = client_details('test');

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
                .send({transaction_id: u1.txn, cancel: 'Deny', scope: c.scope})
                .redirects(0) // don't follow any redirects
                .end(validate.consent_denied(u1, c.uri + '#error=access_denied', done));
        });
        it('should still be authenticated', function(done){
            u1.a.get(host + '/authorize?' + c.params + '&state=foo')
                .end(validate.requesting_consent_no_redirect(u1, c.params, done));
        });
        it('should preserve state param on failure redirect', function(done){
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn, cancel: 'Deny', scope: c.scope})
                .redirects(0)
                .end(validate.consent_denied(u1, c.uri + '#error=access_denied' + '&state=foo', done));
        });
        it('should not allow transaction IDs to be reused after failure', function(done){
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn, scope: c.scope})
                .redirects(0)
                .end(validate.consent_denied_no_tid(u1, c.params + '&state=foo', done));
        });
        it('should still be authenticated', function(done){
            u1.a.get(host + '/authorize?' + c.params + '&state=foo')
                .end(validate.requesting_consent_no_redirect(u1, c.params, done));
        });
        var token = undefined;
        it('should grant token on user consent', function(done){
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn, scope: c.scope})
                .redirects(0)
                .end(validate.token(u1, c.uri, 'read-only', 'foo', done));
        });
        it('should still be authenticated', function(done){
            token = u1.token;
            u1.a.get(host + '/authorize?' + c.params)
                .end(validate.requesting_consent_no_redirect(u1, c.params, done));
        });
        it('should allow another token to be granted', function(done){
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn, scope: 'read-only'})
                .redirects(0)
                .end(validate.token(u1, c.uri, 'read-only', null, done));
        });
        it('should have issued a different token', function(){
            token.should.not.equal(u1.token);
        });
        it('should allow API access for new token', function(done){
            make_user().a.get(host + '/api/profile')
                         .set('Authorization', 'Bearer ' + u1.token)
                         .end(validate.api_access(u1, done));
        });
    });
});

