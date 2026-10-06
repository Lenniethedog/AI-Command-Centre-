-- Instant becomes the default effort: one worker, no planner/synthesiser
-- model calls. Operators who already chose careful/deep keep their choice.
UPDATE setting
SET value = 'instant', updated_at = datetime('now')
WHERE key = 'effort' AND value = 'balanced';
