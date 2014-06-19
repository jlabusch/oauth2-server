var fs = require('fs'),
    cluster = require('cluster'),
    log = require('../lib/logging').log,
    config = require('../lib/config');

exports.run = function(){
    var PIDFILE = process.argv[1] + '.pid';
    fs.writeFile(PIDFILE, process.pid + '\n', function(err){
        if (err){
            log('error', "Couldn't write process ID to " + PIDFILE);
        }else{
            log('notice', "Created " + PIDFILE);
        }
    });

    var CPUS = require('os').cpus().length,
        WORKERS_PER_CPU = CPUS > 1 ? 1 : 2;

    config.on('need_reload', function(){
        for (var id in cluster.workers){
            cluster.workers[id].send('reload');
        }
        config.reload();
    });

    function spawn_child(){
        var w = cluster.fork();
        w.on('message', function(m){
            log('warn', 'Unhandled message from child: ' + JSON.stringify(m));
        });
        log('warn', 'spawned worker ' + w.id + ' (PID ' + w.process.pid + ')');
        return w;
    }

    for (var i = 0; i < CPUS*WORKERS_PER_CPU; ++i){
        spawn_child();
    }

    cluster.on('exit', function(worker, code, signal){
        log('warn', 'worker PID ' + worker.process.pid + ' died (' + (signal || code) + ')');
        spawn_child();
    });
}
