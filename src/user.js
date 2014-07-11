var passport = require('passport'),
    log = require('../lib/logging').log,
    librs = require('../lib/resource_server');

var rsapi = {
    scopes: []
};

librs.load_api(function(err, api){
    if (!err){
        rsapi = api;
    }
});

function allowCrossDomain(req, res, next){
    res.header('Access-Control-Allow-Origin', '*');
    // Allow all methods; controlling that in the express routing is better than relying on the user agent
    if (req.headers['access-control-request-method']){
        res.header('Access-Control-Allow-Methods', req.headers['access-control-request-method']);
    }
    // Allow all headers
    if (req.headers['access-control-request-headers']){
        res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
    }
    next();
}

// Preflight checks are required for any cross domain XHR that sets non-trivial headers (e.g. bearer auth)
exports.preflight = [
    allowCrossDomain,
    function(req, res){
        res.send(200);
    }
]

exports.api = [
    allowCrossDomain,
    passport.authenticate('bearer', { session: false }),
    function(req, res){
        var api = rsapi[req.params.fn];
        if (!api || typeof(api.fn) !== 'function'){
            var msg = 'No such function /api/' + req.params.fn;
            log('warn', msg);
            res.status(404);
            res.json({
                success: 0,
                message: msg,
                error: 'no such function'
            });
            return;
        }
        var ss = req.authInfo.scope;
        if (!req.authInfo.scope){
            log('warn', 'No scope associated with access token');
            ss = [rsapi.scopes[0]];
        }
        var scope_ok = false,
            min_scope = rsapi.scopes.indexOf(api.scope);
        ss.forEach(function(s){
            scope_ok = scope_ok || rsapi.scopes.indexOf(s) >= min_scope;
        });
        if (!scope_ok){
            res.status(403);
            var msg = 'Access token has insufficient scope for /api/' + req.params.fn + ' (' + ss.join(', ') + ' vs. ' + api.scope + ')';
            log('warn', msg);
            res.json({
                success: 0,
                message: msg,
                error: 'insufficient scope'
            });
            return;
        }
        return api.fn(req, res);
    }
]

