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
    token: function(u, sp_redirect_uri, done){
        return function(err, res){
            delete u.txn;
            should.not.exist(err);
            res.should.have.status(302);
            (!res.redirects).should.be.false;
            var redir = res.headers['location'].match(/(.*)#access_token=([^&]+)&token_type=Bearer/);
            (!redir).should.be.false;
            redir[1].should.equal(sp_redirect_uri);
            u.token = redir[2];
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

describe('implicit grant', function(){
    var sp_redirect_uri = 'http://localhost:8080/';
    var sp_link_params = encodeURI('response_type=token&client_id=sp-demo&redirect_uri=' + sp_redirect_uri);

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
                // Don't use this username in any other implicit tests!
                .send({username: 'stuff3@tdc-design.com.x', password: good_password})
                .end(validate.consent(u1, sp_link_params, done));
        });
        it('should consent and redir to client with token', function(done){
            this.timeout(5*1000);
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn})
                .redirects(0)
                .end(validate.token(u1, sp_redirect_uri, done));
        });
        it('should allow API access', function(done){
            u1.a.get(host + '/api/userinfo')
                .set('Authorization', 'Bearer ' + u1.token)
                .end(validate.api_access(u1, done));
        });
    });
    describe('multi-user flow', function(){
        var u1 = make_user()
            u2 = make_user();

        it('u1 /login', function(done){
            u1.a.get(host + '/authorize?' + sp_link_params)
                .end(validate.challenge(u1, done));
        });
        it('u2 /login', function(done){
            u2.a.get(host + '/authorize?' + sp_link_params)
                .end(validate.challenge(u2, done));
        });
        it('u1 auth + consent', function(done){
            this.timeout(10*1000);
            u1.a.post(host + '/login')
                .send({username: 'catalyst.tester@gmail.com.x', password: good_password})
                .end(validate.consent(u1, sp_link_params, done));
        });
        it('u2 auth + consent', function(done){
            this.timeout(10*1000);
            u2.a.post(host + '/login')
                .send({username: 'catalyst.tester@yahoo.com.x', password: good_password})
                .end(validate.consent(u2, sp_link_params, done));
        });
        it('u2 gets token', function(done){
            this.timeout(5*1000);
            u2.a.post(host + '/authorize')
                .send({transaction_id: u2.txn})
                .redirects(0)
                .end(validate.token(u2, sp_redirect_uri, done));
        });
        it('u1 gets token', function(done){
            this.timeout(5*1000);
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn})
                .redirects(0)
                .end(validate.token(u1, sp_redirect_uri, done));
        });
        it('u1 API access', function(done){
            u1.a.get(host + '/api/userinfo')
                .set('Authorization', 'Bearer ' + u1.token)
                .end(validate.api_access(u1, done));
        });
        it('u2 API access', function(done){
            u2.a.get(host + '/api/userinfo')
                .set('Authorization', 'Bearer ' + u2.token)
                .end(validate.api_access(u2, done));
        });
    });
    describe('resource owner denies client access', function(){
        var u1 = make_user();

        it('should redir to /login', function(done){
            u1.a.get(host + '/authorize?' + sp_link_params)
                .end(validate.challenge(u1, done));
        });
        it('should auth and prompt for consent', function(done){
            this.timeout(10*1000);
            u1.a.post(host + '/login')
                .send({username: 'catalyst.tester@gmail.com.x', password: good_password})
                .end(validate.consent(u1, sp_link_params, done));
        });
        it('should redirect with error', function(done){
            this.timeout(5*1000);
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn, cancel: 'Deny'})
                .redirects(0)
                .end(validate.no_token(u1, sp_redirect_uri, done));
        });
    });
    describe('resource owner already logged in', function(){
        var u1 = basic_flow_user;
        var prev_token,
            new_token;

        it('should redir to /authorize', function(done){
            this.timeout(5*1000);
            prev_token = u1.token;
            u1.a.get(host + '/authorize?' + sp_link_params)
                .end(validate.consent_already_logged_in(u1, sp_link_params, done));
        });
        it('should consent and redir to client with token', function(done){
            this.timeout(5*1000);
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn})
                .redirects(0)
                .end(validate.token(u1, sp_redirect_uri, done));
        });
        it('should not allocate a new token', function(){
            new_token = u1.token;
            prev_token.should.equal(new_token);
        });
        it('should allow API access', function(done){
            u1.a.get(host + '/api/userinfo')
                .set('Authorization', 'Bearer ' + prev_token)
                .end(validate.api_access(u1, done));
        });
    });
    describe('resource owner revoking consent through front channel', function(){
        var u1 = basic_flow_user;

        it('should redir to /authorize', function(done){
            this.timeout(5*1000);
            u1.a.get(host + '/authorize?' + sp_link_params)
                .end(validate.consent_already_logged_in(u1, sp_link_params, done));
        });
        it('should redir with denial error', function(done){
            this.timeout(5*1000);
            u1.a.post(host + '/authorize')
                .send({transaction_id: u1.txn, cancel: 'Deny'})
                .redirects(0)
                .end(validate.no_token(u1, sp_redirect_uri, done));
        });
        it('should no longer allow API access', function(done){
            u1.a.get(host + '/api/userinfo')
                .set('Authorization', 'Bearer ' + u1.token)
                .end(validate.api_access_failed_bad_token(u1, done));
        });
    });
});

