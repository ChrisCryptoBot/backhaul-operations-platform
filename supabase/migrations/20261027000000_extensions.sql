-- Preflight. The trigram indexes in 20261106100000_scale_indexes_terminals need pg_trgm.
create extension if not exists pg_trgm with schema public;
