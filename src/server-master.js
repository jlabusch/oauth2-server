var fs = require('fs'),
    cluster = require('cluster'),
    log = require('../lib/logging').log,
    config = require('../lib/config');

exports.run = function(){
    var PIDFILE = process.argv.length > 2 ? process.argv[2] : './server.js.pid';
    fs.writeFile(PIDFILE, process.pid + '\n', function(err){
        if (err){
            log('error', "Couldn't write process ID to " + PIDFILE);
        }else{
            log('notice', "Created " + PIDFILE);
        }
    });

    config.on('need_reload', function(){
        for (var id in cluster.workers){
            cluster.workers[id].send('reload');
        }
        config.reload();
        log('notice', "Config reloaded");
    });

    function spawn_child(){
        var w = cluster.fork();
        w.on('message', function(m){
            log('warn', 'Unhandled message from child: ' + JSON.stringify(m));
        });
        log('warn', 'spawned worker ' + w.id + ' (PID ' + w.process.pid + ')');
        return w;
    }

    config.defer(function(err, conf){
        var n = parseInt(conf.auth_server.num_workers);
        if (!n || isNaN(n)){
            n = require('os').cpus().length;
        }
        for (var i = 0; i < n; ++i){
            spawn_child();
        }
    });

    var backoff = new (function(){
        var self = this;
        this.__last = 0;
        this.update = function(){ self.__last = (new Date()).getTime(); };
        this.delay  = function(){
            var since_last = (new Date()).getTime() - self.__last;
            if (since_last > 8000){ return 0; }
            if (since_last > 4000){ return 250; }
            if (since_last > 2000){ return 500; }
            if (since_last > 1000){ return 1000; }
            return 2000;
        };
    })();

    cluster.on('exit', function(worker, code, signal){
        log('warn', 'worker PID ' + worker.process.pid + ' died (' + (signal || code) + ')');
        setTimeout(spawn_child, backoff.delay());
        backoff.update();
    });
}
