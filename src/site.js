var passport = require('passport'),
    config = require('../lib/config'),
    login = require('connect-ensure-login');

var login_view = 'login';

config.defer(function(err, cfg){
    login_view = cfg.auth_server.views.login || login_view;
});

exports.loginForm = function(req, res){
    res.render(login_view, {message: null});
};

exports.login = function(req, res, next){
    passport.authenticate('local', function(err, user, info){
        if (err){
            return next(err);
        }
        if (!user){
            // Auth failed. Pass through the "message" parameter only.
            return res.render(login_view, {message: info.message});
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
    res.redirect('/');
}

