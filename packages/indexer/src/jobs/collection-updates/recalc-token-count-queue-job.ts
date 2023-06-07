import { idb } from "@/common/db";
import { AbstractRabbitMqJobHandler, BackoffStrategy } from "@/jobs/abstract-rabbit-mq-job-handler";
import { logger } from "@/common/logger";

export type RecalcTokenCountQueueJobPayload = {
  collection: string;
  force?: boolean;
};

export class RecalcTokenCountQueueJob extends AbstractRabbitMqJobHandler {
  queueName = "collection-recalc-token-count-queue";
  maxRetries = 10;
  concurrency = 1;
  backoff = {
    type: "exponential",
    delay: 20000,
  } as BackoffStrategy;

  protected async process(payload: RecalcTokenCountQueueJobPayload) {
    const { collection } = payload;

    const query = `
          UPDATE "collections"
          SET "token_count" = (SELECT COUNT(*) FROM "tokens" WHERE "collection_id" = $/collection/),
              "updated_at" = now()
          WHERE "id" = $/collection/;
      `;

    await idb.none(query, {
      collection,
    });

    logger.info(this.queueName, `Updated token count for collection ${collection}`);
  }

  public async addToQueue(collection: RecalcTokenCountQueueJobPayload) {
    await this.send({
      payload: collection,
      jobId: collection.force ? undefined : collection.collection,
    });
  }
}

export const recalcTokenCountQueueJob = new RecalcTokenCountQueueJob();
