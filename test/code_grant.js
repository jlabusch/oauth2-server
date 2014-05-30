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
    code: function(u, sp_redirect_uri, done){
        return function(err, res){
            delete u.txn;
            should.not.exist(err);
            res.should.have.status(302);
            (!res.redirects).should.be.false;
            var redir = res.headers['location'].match(/(.*)?\?code=([^&]+)&state=deadbeef/);
            (!redir).should.be.false;
            redir[1].should.equal(sp_redirect_uri);
            u.code = redir[2];
            var sid_match = res.headers['set-cookie'].toString().match(/sid=([^;]+)/);
            (null !== sid_match).should.be.true;
            u.sid.should.equal(sid_match[1]);
            done();
        }
    },
    token: function(u, done, keep_code){
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
            res.should.have.status(400);
            var j = get_json(res.text);
            should.exist(j.error);
            j.error.should.equal('invalid_request');
            (!j.error_description.match(/refresh_token/)).should.be.false;
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
    api_err_bad_token: function(u, done){
        return function(err, res){
            should.not.exist(err);
            res.should.have.status(401);
            done();
        }
    }
};

describe('refresh token', function(){
    var sp_redirect_uri = 'http://localhost:8080/',
        sp_link_params =     encodeURI('response_type=code&client_id=sp-demo&redirect_uri=' + sp_redirect_uri + '&state=deadbeef');

    var user;
    describe('basic flow', function(){
        var u1 = make_user();
        user = u1;

        it('should redir to /login', function(done){
            u1.a.get(host + '/authorize?' + sp_link_params)
                .end(validate.challenge(u1, done));
        });
        it('should auth and prompt for consent', function(done){
            this.timeout(10*1000);
            u1.a.post(host + '/login')
                .send({username: 'em_test@tdc-design.com.x', password: good_password})
                .end(validate.consent(u1, sp_link_params, done));
        });
        it('should consent and redir to client with code', function(done){
            this.timeout(5*1000);
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn})
                .redirects(0)
                .end(validate.code(u1, sp_redirect_uri, done));
        });
        it('should exchange code for token', function(done){
            make_user().a.post(host + '/token')
                         .send({
                            grant_type: 'authorization_code',
                            code: u1.code,
                            // side-effect: test ClientPasswordStrategy by putting creds in the body
                            client_id: 'sp-demo',
                            client_secret: 'hunter2',
                            redirect_uri: sp_redirect_uri
                         })
                         .end(validate.token(u1, done, true));
        });
        it('should allow API access', function(done){
            u1.a.get(host + '/api/userinfo')
                .set('Authorization', 'Bearer ' + u1.token)
                .end(validate.api_access(u1, done));
        });
    });
    describe('exchange', function(){
        var u1 = user;
        var origAT = u1.token,
            origRT = u1.refresh_token;

        it('should return error for bad token', function(done){
            u1.a.get(host + '/api/userinfo')
                .set('Authorization', 'Bearer ' + u1.token+'XXX')
                .end(validate.api_err_bad_token(u1, done));
        });
        it('should return a new token', function(done){
            u1.a.post(host + '/token')
                .auth('sp-demo', 'hunter2')
                .send({
                    grant_type: 'refresh_token',
                    refresh_token: u1.refresh_token
                })
                .end(validate.token(u1, done, true));
        });
        it('should have changed both AT and RT', function(){
            (origAT !== u1.token).should.be.true;
            (origRT !== u1.refresh_token).should.be.true;
        });
        it('should not allow old refresh token to be used again', function(done){
            u1.a.post(host + '/token')
                .auth('sp-demo', 'hunter2')
                .send({
                    grant_type: 'refresh_token',
                    refresh_token: origRT
                })
                .end(validate.token_err_bad_refresh_token(u1, done, true));
        });
        it('should not allow API access for old token', function(done){
            u1.a.get(host + '/api/userinfo')
                .set('Authorization', 'Bearer ' + origAT)
                .end(validate.api_err_bad_token(u1, done));
        });
        it('should allow API access for new token', function(done){
            u1.a.get(host + '/api/userinfo')
                .set('Authorization', 'Bearer ' + u1.token)
                .end(validate.api_access(u1, done));
        });
        it('should return another new token', function(done){
            u1.a.post(host + '/token')
                .auth('sp-demo', 'hunter2')
                .send({
                    grant_type: 'refresh_token',
                    refresh_token: u1.refresh_token
                })
                .end(validate.token(u1, done, true));
        });
        it('should allow API access', function(done){
            u1.a.get(host + '/api/userinfo')
                .set('Authorization', 'Bearer ' + u1.token)
                .end(validate.api_access(u1, done));
        });
    });
});

describe('auth code grant', function(){
    var sp_redirect_uri = 'http://localhost:8080/',
        sp_link_params =     encodeURI('response_type=code&client_id=sp-demo&redirect_uri=' + sp_redirect_uri + '&state=deadbeef'),
        sp_link_params_alt = encodeURI('response_type=code&client_id=test&redirect_uri=' + sp_redirect_uri + '&state=deadbeef');

    var basic_flow_user = null;
    describe('basic flow', function(){
        var u1 = make_user();
        basic_flow_user = u1;

        it('should redir to /login', function(done){
            u1.a.get(host + '/authorize?' + sp_link_params)
                .end(validate.challenge(u1, done));
        });
        it('should auth and prompt for consent', function(done){
            this.timeout(10*1000);
            u1.a.post(host + '/login')
                .send({username: 'em_test@tdc-design.com.x', password: good_password})
                .end(validate.consent(u1, sp_link_params, done));
        });
        it('should consent and redir to client with code', function(done){
            this.timeout(5*1000);
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn})
                .redirects(0)
                .end(validate.code(u1, sp_redirect_uri, done));
        });
        it('should exchange code for token', function(done){
            make_user().a.post(host + '/token')
                         .send({
                            grant_type: 'authorization_code',
                            code: u1.code,
                            // side-effect: test ClientPasswordStrategy by putting creds in the body
                            client_id: 'sp-demo',
                            client_secret: 'hunter2',
                            redirect_uri: sp_redirect_uri
                         })
                         .end(validate.token(u1, done, true));
        });
        it('should allow API access', function(done){
            u1.a.get(host + '/api/userinfo')
                .set('Authorization', 'Bearer ' + u1.token)
                .end(validate.api_access(u1, done));
        });
    });
    var basic_flow_user_alt = null;
    describe('basic flow', function(){
        var u1 = make_user();
        basic_flow_user_alt = u1;

        it('should redir to /login', function(done){
            u1.a.get(host + '/authorize?' + sp_link_params_alt)
                .end(validate.challenge(u1, done));
        });
        it('should auth and prompt for consent', function(done){
            this.timeout(10*1000);
            u1.a.post(host + '/login')
                .send({username: 'em_test@tdc-design.com.x', password: good_password})
                .end(validate.consent(u1, sp_link_params_alt, done));
        });
        it('should consent and redir to client with code', function(done){
            this.timeout(5*1000);
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn})
                .redirects(0)
                .end(validate.code(u1, sp_redirect_uri, done));
        });
        it('should exchange code for token', function(done){
            make_user().a.post(host + '/token')
                         .send({
                            grant_type: 'authorization_code',
                            code: u1.code,
                            client_id: 'test',
                            client_secret: 'hunter2',
                            redirect_uri: sp_redirect_uri
                         })
                         .end(validate.token(u1, done, true));
        });
        it('should allow API access', function(done){
            u1.a.get(host + '/api/userinfo')
                .set('Authorization', 'Bearer ' + u1.token)
                .end(validate.api_access(u1, done));
        });
    });
    describe('multiple client sanity check', function(){
        it('should have issued different tokens to different clients', function(){
            should.exist(basic_flow_user.token);
            should.exist(basic_flow_user_alt.token);
            basic_flow_user.token.should.not.equal(basic_flow_user_alt.token);
        });
    });
    describe('code redemption', function(){
        it('should not allow code to be used twice', function(done){
            make_user().a.post(host + '/token')
                         .send({
                            grant_type: 'authorization_code',
                            code: basic_flow_user.code,
                            client_id: 'sp-demo',
                            client_secret: 'hunter2',
                            redirect_uri: sp_redirect_uri
                         })
                         .end(validate.token_err_bad_code(null, done));
        });
        it('should not invalidate existing tokens', function(done){
            var u1 = basic_flow_user;
            u1.a.get(host + '/api/userinfo')
                .set('Authorization', 'Bearer ' + u1.token)
                .end(validate.api_access(u1, done));
        });
    });

    var sp_bad_client_link_params = encodeURI('response_type=code&client_id=XXX&redirect_uri=' + sp_redirect_uri + '&state=deadbeef');
    describe('invalid client ID in URI', function(){
        var u1 = make_user();

        it('should redir to /login', function(done){
            u1.a.get(host + '/authorize?' + sp_bad_client_link_params)
                .end(validate.challenge(u1, done));
        });
        it('should fail auth', function(done){
            this.timeout(10*1000);
            u1.a.post(host + '/login')
                .send({username: 'ittesters@hotmail.co.nz.x', password: good_password})
                .end(validate.login_failed_bad_client(u1, sp_link_params, done));
        });
    });

    describe('invalid client ID in token exchange', function(){
        var u1 = make_user();

        it('should redir to /login', function(done){
            u1.a.get(host + '/authorize?' + sp_link_params)
                .end(validate.challenge(u1, done));
        });
        it('should auth and prompt for consent', function(done){
            this.timeout(10*1000);
            u1.a.post(host + '/login')
                .send({username: 'testing.stuff123@yahoo.co.nz.x', password: good_password})
                .end(validate.consent(u1, sp_link_params, done));
        });
        it('should consent and redir to client with code', function(done){
            this.timeout(5*1000);
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn})
                .redirects(0)
                .end(validate.code(u1, sp_redirect_uri, done));
        });
        it('should fail to exchange code for token with valid-but-mismatched client ID', function(done){
            make_user().a.post(host + '/token')
                         // side-effect: test BasicStrategy by putting creds in the header
                         .auth('test', 'hunter2')
                         .send({
                            grant_type: 'authorization_code',
                            code: u1.code,
                            redirect_uri: sp_redirect_uri
                         })
                         .end(validate.token_err_bad_client(null, done));
        });
        it('should fail even with good client ID - codes are one-time things', function(done){
            make_user().a.post(host + '/token')
                         .auth('sp-demo', 'hunter2')
                         .send({
                            grant_type: 'authorization_code',
                            code: u1.code,
                            redirect_uri: sp_redirect_uri
                         })
                         .end(validate.token_err_bad_client(null, done));
        });
    });
    describe('bad resource owner password', function(){
        var u1 = make_user();

        it('should redir to /login', function(done){
            u1.a.get(host + '/authorize?' + sp_link_params)
                .end(validate.challenge(u1, done));
        });
        it('should fail auth', function(done){
            this.timeout(10*1000);
            u1.a.post(host + '/login')
                .send({username: 'test@test.com.x', password: bad_password})
                .end(validate.login_failed_bad_password(u1, sp_link_params, done));
        });
    });
});

