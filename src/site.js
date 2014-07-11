var passport = require('passport'),
    config = require('../lib/config'),
    librs = require('../lib/resource_server'),
    login = require('connect-ensure-login');

var login_view = 'login';

config.defer(function(err, cfg){
    login_view = cfg.auth_server.views.login || login_view;
});

var set_view_context = function(x){ return x; }

librs.load_context_fn(function(err, fn){
    if (!err){
        set_view_context = fn;
    }
});

exports.loginForm = function(req, res){
    res.render(login_view, set_view_context({message: null}));
};

exports.login = function(req, res, next){
    passport.authenticate('local', function(err, user, info){
        if (err){
            return next(err);
        }
        if (!user){
            // Auth failed. Pass through the "message" parameter only.
            return res.render(login_view, set_view_context({message: info.message}));
        }
        req.login(user, function(err){
            if (err){
                return next(err);
            }
            var url = '/';
            if (req.session && req.session.returnTo) {
                url = req.session.returnTo;
                delete req.session.returnTo;
            }
            return res.redirect(url);
        });
    })(req, res, next);
};

exports.logout = function(req, res){
    req.logout();
    var to = req.param('redirect_uri');
    if (to){
        res.redirect(to);
    }else{
        res.send(204);
    }
}

