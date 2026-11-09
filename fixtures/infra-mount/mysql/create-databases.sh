#!/bin/bash
# Creates the service databases; the root password comes from the environment.
set -e

mysql -h 127.0.0.1 -uroot -p"$ROOT_PW" <<EOF2
CREATE DATABASE acme_orders_db;
GRANT ALL ON acme_orders_db.* TO 'orders'@'%';
EOF2

psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE acme_reports_db"
