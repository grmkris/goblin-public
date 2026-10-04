-- Accounts created before email verification existed keep working as they are.
update "user" set "emailVerified" = 1 where "emailVerified" = 0;

-- Better Auth's database rate-limit store: auth runs per request, so in-memory limits would reset on every call.
create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);
