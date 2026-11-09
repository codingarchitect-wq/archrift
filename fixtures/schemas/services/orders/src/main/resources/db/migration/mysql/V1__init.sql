CREATE TABLE customer (
  id BIGINT NOT NULL AUTO_INCREMENT,
  version BIGINT NOT NULL,
  name VARCHAR(100),
  street_name VARCHAR(255) NOT NULL,
  town VARCHAR(255),
  PRIMARY KEY (id)
) ENGINE = InnoDB;

CREATE TABLE `purchase_order` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `version` BIGINT NOT NULL,
  `customer_id` BIGINT NOT NULL,
  `number` VARCHAR(20) NOT NULL,
  `placed_at` DATETIME(6) NOT NULL,
  KEY `IX_Order_Placed` (`placed_at`),
  CONSTRAINT `FK_Order_Customer` FOREIGN KEY (`customer_id`) REFERENCES `customer` (`id`) ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE audit_entry (id BIGINT PRIMARY KEY, text TEXT);

CREATE TABLE customer_tag (customer_id BIGINT NOT NULL REFERENCES customer (id), tags VARCHAR (50) NOT NULL);

DELIMITER $$
CREATE TRIGGER order_audit AFTER INSERT ON purchase_order FOR EACH ROW
BEGIN
  INSERT INTO audit_entry (id, text) VALUES (NEW.id, 'created; new');
END$$
DELIMITER ;

CREATE TABLE payment (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  version BIGINT NOT NULL,
  dtype VARCHAR(31) NOT NULL,
  amount BIGINT NOT NULL,
  card_number VARCHAR(19)
);

CREATE TABLE legacy_refund (id BIGINT PRIMARY KEY);
