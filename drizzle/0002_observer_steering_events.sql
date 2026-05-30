CREATE TABLE `steering_events` (
	`id` text PRIMARY KEY NOT NULL,
	`observed_run_id` text NOT NULL,
	`observer_run_id` text,
	`target_span_id` text,
	`target_subagent_span_id` text,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`before_prompt` text,
	`after_prompt` text,
	`reason` text,
	`source` text NOT NULL,
	`confidence` real,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_steering_observed` ON `steering_events` (`observed_run_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_steering_observer` ON `steering_events` (`observer_run_id`) WHERE "steering_events"."observer_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_steering_target_span` ON `steering_events` (`target_span_id`) WHERE "steering_events"."target_span_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_steering_target_subagent` ON `steering_events` (`target_subagent_span_id`) WHERE "steering_events"."target_subagent_span_id" IS NOT NULL;
