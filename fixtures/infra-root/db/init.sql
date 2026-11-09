-- Local development schema
CREATE DATABASE IF NOT EXISTS orders_local;

CREATE TABLE IF NOT EXISTS `orders` (
  id BIGINT PRIMARY KEY,
  customer VARCHAR(100) NOT NULL
);

/* a view over the orders */
CREATE VIEW open_orders AS SELECT * FROM orders;
