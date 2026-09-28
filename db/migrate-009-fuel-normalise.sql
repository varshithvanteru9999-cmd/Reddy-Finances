-- ------------------------------------------------------------------
-- Migration 009 — align fuel values with the admin dropdown
--
-- The Fleet editor now offers a fixed list: Gas, Hybrid, Diesel,
-- Electric. Seeded rows used "Gasoline", which would show as an unknown
-- value and be silently rewritten the first time an admin saved the
-- vehicle. Normalise the existing data instead.
-- ------------------------------------------------------------------

UPDATE vehicles SET fuel = 'Gas'
 WHERE fuel IN ('Gasoline', 'Petrol', 'gasoline', 'petrol', 'gas');

UPDATE vehicles SET fuel = 'Hybrid'   WHERE LOWER(fuel) LIKE 'hybrid%';
UPDATE vehicles SET fuel = 'Diesel'   WHERE LOWER(fuel) = 'diesel';
UPDATE vehicles SET fuel = 'Electric' WHERE LOWER(fuel) IN ('electric', 'ev', 'battery electric');
