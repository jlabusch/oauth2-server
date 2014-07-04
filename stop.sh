#!/bin/bash

PIDDIR=/var/run
if stat --printf='' ./*.pid >/dev/null 2>&1; then
    PIDDIR=.
fi

function stopf(){
    APP=$1
    PIDFILE=$PIDDIR/$(basename $APP).pid

    test -e $PIDFILE && pkill -F $PIDFILE && echo "stopping $APP"
    rm -f $PIDFILE
}

stopf ./src/server.js
stopf ./dummy-servers/resource-server.js
