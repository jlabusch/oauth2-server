CREATE TABLE audit (
    id  bigserial PRIMARY KEY,
    key text NOT NULL,
    value text NOT NULL,
    ctime timestamp with time zone default NOW()
);
