#!/bin/bash

PIDDIR=/var/run
if [ "$NODE_ENV" = "test" ] || [ ! -w $PIDDIR ] ; then
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
