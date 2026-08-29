-- Add the two trade sides short selling needs. Postgres cannot use a newly
-- added enum value within the transaction that adds it, so this has to be its
-- own migration ahead of 0003_short_selling.sql, which is the one that
-- actually references 'short' and 'cover'.
alter type trade_side add value 'short';
alter type trade_side add value 'cover';
