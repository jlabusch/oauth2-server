var passport = require('passport'),
    log = require('../lib/logging').log,
    librs = require('../lib/resource_server');

librs.load_query(function(err, fn){
    // TODO: check err
    query_fn = fn;
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

var query_fn = function(){}

exports.info = [
    allowCrossDomain,
    passport.authenticate('bearer', { session: false }),
    function(req, res){ query_fn(req, res); }
]

