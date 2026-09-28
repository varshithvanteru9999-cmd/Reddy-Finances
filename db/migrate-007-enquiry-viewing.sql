-- ------------------------------------------------------------------
-- enquiries.kind was missing 'viewing'.
--
-- The car detail page sends kind='viewing' when a customer asks to see
-- a car that is for sale, but the enum only allowed consultation/sell/
-- general — so MySQL rejected the row and every viewing request was
-- lost. This adds the missing value.
--
-- Safe to re-run.
-- ------------------------------------------------------------------

USE reddy_finances;

ALTER TABLE enquiries
  MODIFY COLUMN kind ENUM('consultation','sell','general','viewing')
  NOT NULL DEFAULT 'general';
