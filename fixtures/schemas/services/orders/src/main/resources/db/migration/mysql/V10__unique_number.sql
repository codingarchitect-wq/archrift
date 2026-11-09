-- version 10 runs after version 2
CREATE UNIQUE INDEX UK_Order_Number ON purchase_order (number);
ALTER TABLE customer DROP COLUMN version;
ALTER TABLE customer ADD COLUMN version BIGINT NOT NULL DEFAULT 0;
