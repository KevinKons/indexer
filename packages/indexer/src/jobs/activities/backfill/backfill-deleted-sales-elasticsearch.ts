import { Queue, QueueScheduler, Worker } from "bullmq";

import { redis } from "@/common/redis";
import { config } from "@/config/index";
import * as ActivitiesIndex from "@/elasticsearch/indexes/activities";
import { randomUUID } from "crypto";
import { fromBuffer } from "@/common/utils";
import { idb } from "@/common/db";
import { logger } from "@/common/logger";
import { elasticsearch } from "@/common/elasticsearch";
import { ActivityDocument } from "@/elasticsearch/indexes/activities/base";

const QUEUE_NAME = "backfill-deleted-sales-elasticsearch-queue";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    removeOnComplete: 1000,
    removeOnFail: 1000,
    backoff: {
      type: "fixed",
      delay: 5000,
    },
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork && config.doElasticsearchWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const results = await idb.manyOrNone(
        "select * from fill_events_2 where order_id is null and order_kind = 'blur-v2' and timestamp >= 1688187822"
      );

      if (results.length) {
        const toBeDeletedActivityIds: string[] = [];

        results.forEach((result) => {
          const query = {
            bool: {
              must_not: [
                {
                  exists: {
                    field: "order",
                  },
                },
              ],
              must: [
                {
                  term: {
                    "event.txHash": fromBuffer(result.tx_hash),
                  },
                },
                {
                  term: {
                    "event.logIndex": result.log_index,
                  },
                },
                {
                  term: {
                    "event.batchIndex": result.batch_index,
                  },
                },
                {
                  terms: {
                    type: ["sale"],
                  },
                },
              ],
            },
          };

          const esResult = await elasticsearch.search<ActivityDocument>({
            index: ActivitiesIndex.getIndexName(),
            // This is needed due to issue with elasticsearch DSL.
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            query,
            size: 1,
          });

          const activities = esResult.hits.hits.map((hit) => hit._source!);

          logger.info(
            QUEUE_NAME,
            `Debug: activityId=${activities[0].id} txHash=${fromBuffer(result.tx_hash)} logIndex=${
              result.log_index
            } batchIndex=${result.batch_index}`
          );

          toBeDeletedActivityIds.push(activities[0].id);
        });

        logger.info(QUEUE_NAME, `Debug2: toBeDeletedActivityIds=${toBeDeletedActivityIds.length}`);

        await ActivitiesIndex.deleteActivitiesById(toBeDeletedActivityIds);
      }
    },
    { connection: redis.duplicate(), concurrency: 1 }
  );

  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export const addToQueue = async (delay = 1000) => {
  await queue.add(randomUUID(), {}, { delay });
};
