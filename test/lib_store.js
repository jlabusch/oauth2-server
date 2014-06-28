var assert  = require('assert'),
    config  = require('../lib/config'),
    storage = require('../lib/store'),
    should  = require('should');

function introduce_lag(obj){
    obj.__raw_client = obj.__client;
    function slow(fname){
        return function(){
            var args = Array.prototype.slice.call(arguments, 0);
            setTimeout(function(){ obj.__raw_client[fname].apply(obj.__raw_client, args) }, 50);
        }
    }
    obj.__client = [
        'query',
        'set',
        'setex',
        'get',
        'mget',
        'del'
    ].reduce(function(r, f){ r[f] = slow(f); return r;}, {});
}

describe('Storage', function(){
    var pg_table = 'test_postgres';
    describe('setup', function(){
        it('should clean out ' + pg_table, function(done){
            this.timeout(5000);
            storage.create(pg_table, function(err, store){
                should.not.exist(err);
                // wait for pg_reconnect to finish
                setTimeout(function(){
                    store.__client.query('delete from ' + pg_table, function(err){
                        should.not.exist(err);
                        done();
                    });
                }, 500);
            });
        });
    });
    describe('Postgres', function(){
        var pg_store = null;
        it('should create a store', function(done){
            this.timeout(5000);
            pg_store = storage.create(pg_table, function(err, store){
                should.not.exist(err);
                should.exist(store);
                store.__table.should.equal(pg_table);
                pg_store = store;
                introduce_lag(pg_store);
                done();
            });
        });
        function check_pg_rows(preds, data){
            should.exist(data.rows);
            data.rowCount.should.equal(preds.length);
            data.rows.length.should.equal(preds.length);
            preds.forEach(function(p, i){
                var v = null;
                try{
                    v = JSON.parse(data.rows[i].value);
                }catch(ex){
                    should.not.exist(ex);
                }
                if (typeof(p) === 'function'){
                    p(v).should.be.true;
                }else{
                    (p === v).should.be.true;
                }
            });
        }
        it('should support put(key, value)', function(done){
            pg_store.put('simple put', 'hello world', function(err){
                should.not.exist(err);
                pg_store.__raw_client.query('select * from ' + pg_table + ' where key=\'simple put\'', function(err, data){
                    should.not.exist(err);
                    should.exist(data);
                    check_pg_rows(['hello world'], data);
                    done();
                });
            });
        });
        it('should support concurrent put()', function(done){
            pg_store.put('concurrent put', 'hello world', function(err){
                should.not.exist(err);
                pg_store.__raw_client.query('select value from ' + pg_table + " where key='concurrent put'", function(err, data){
                    should.not.exist(err);
                    should.exist(data);
                    check_pg_rows([function(v){ return v === 'hello world' || v === 'goodbye world' }], data);
                });
            });
            pg_store.put('concurrent put', 'goodbye world', function(err){
                should.not.exist(err);
                pg_store.__raw_client.query('select value from ' + pg_table + " where key='concurrent put'", function(err, data){
                    should.not.exist(err);
                    should.exist(data);
                    check_pg_rows([function(v){ return v === 'hello world' || v === 'goodbye world' }], data);
                    done();
                });
            });
        });
        it('should be updating values for put()', function(done){
            pg_store.__raw_client.query('select count(*) from ' + pg_table + " where key='concurrent put'", function(err, data){
                should.not.exist(err);
                should.exist(data);
                data.rowCount.should.equal(1);
                data.rows[0].count.should.equal('1');
                done();
            });
        });
        it('should support append(key, value)', function(done){
            pg_store.append('append 1', 'hello world', function(err){
                should.not.exist(err);
                pg_store.append('append 1', 'goodbye world', function(err){
                    should.not.exist(err);
                    pg_store.__raw_client.query('select value from ' + pg_table + " where key='append 1' order by mtime", function(err, data){
                        should.not.exist(err);
                        should.exist(data);
                        check_pg_rows(['hello world', 'goodbye world'], data);
                        done();
                    });
                });
            });
        });
        it('should support concurrent append()', function(done){
            function pred(v){
                return v.match(/^(hello|goodbye)( again)? world$/) !== null;
            }
            pg_store.append('append 2', 'hello world', function(err){
                should.not.exist(err);
                pg_store.append('append 2', 'goodbye world', function(err){
                    should.not.exist(err);
                });
            });
            pg_store.append('append 2', 'hello again world', function(err){
                should.not.exist(err);
                pg_store.append('append 2', 'goodbye again world', function(err){
                    should.not.exist(err);
                    setTimeout(function(){
                        pg_store.__raw_client.query('select value from ' + pg_table + " where key='append 2' order by mtime", function(err, data){
                            should.not.exist(err);
                            should.exist(data);
                            check_pg_rows([pred, pred, pred, pred], data);
                            done();
                        });
                    }, 500);
                });
            });
        });
        it('should support get(key)');
        it('should support get([keys])');
        it('should support get([keys])');
        it('should support concurrent get()');
        it('should support del(key)');
        it('should support concurrent del()');
    });
});

