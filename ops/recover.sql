-- Run ONLY against an isolated restored database, with the external maintenance gate enabled.
-- A backup cannot prove that a viewer was not revoked after it was taken.
UPDATE users SET enabled=0 WHERE role='viewer';
DELETE FROM grants;
UPDATE user_video SET generation=NULL,sequence=0;
UPDATE scans SET status='cancelled',lease_token=NULL,lease_until=NULL,error='operator_restore'
  WHERE status IN ('listing','reconciling','paused');
UPDATE processor_runs SET status='stopped',lease_until=0,error='operator_restore';
UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,
  token=NULL,run_token=NULL,lease_until=NULL,retry_after=0,error='operator_restore' WHERE state='leased';
UPDATE libraries SET paused=1,next_scan=2147483647;
