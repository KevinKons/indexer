/* eslint-disable @typescript-eslint/no-explicit-any */

import { Request, RouteOptions } from "@hapi/hapi";
import _ from "lodash";
import Joi from "joi";
import { logger } from "@/common/logger";
import { fromBuffer, regex } from "@/common/utils";
import { redb } from "@/common/db";
import * as Sdk from "@reservoir0x/sdk";
import { config } from "@/config/index";
import { getStartTime } from "@/models/top-selling-collections/top-selling-collections";

import { redis } from "@/common/redis";

import {
  getTopSellingCollectionsV2 as getTopSellingCollections,
  TopSellingFillOptions,
} from "@/elasticsearch/indexes/activities";

import { getJoiPriceObject, JoiPrice } from "@/common/joi";
import { Sources } from "@/models/sources";

const version = "v3";

export const getTopSellingCollectionsV3Options: RouteOptions = {
  cache: {
    expiresIn: 60 * 1000,
    privacy: "public",
  },
  description: "Top Selling Collections",
  notes: "Get top selling and minting collections",
  tags: ["api", "Collections"],
  plugins: {
    "hapi-swagger": {
      order: 3,
    },
  },
  validate: {
    query: Joi.object({
      period: Joi.string()
        .valid("5m", "10m", "30m", "1h", "6h", "1d", "24h", "7d", "30d")
        .default("1d")
        .description("Time window to aggregate."),
      fillType: Joi.string()
        .lowercase()
        .valid(..._.values(TopSellingFillOptions))
        .default(TopSellingFillOptions.sale)
        .description("Fill types to aggregate from (sale, mint, any)"),

      limit: Joi.number()
        .integer()
        .min(1)
        .max(1000)
        .default(1000)
        .description("Amount of items returned in response. Default is 25 and max is 50"),
      sortBy: Joi.string().valid("volume", "sales").default("sales"),

      normalizeRoyalties: Joi.boolean()
        .default(false)
        .description("If true, prices will include missing royalties to be added on-top."),
      useNonFlaggedFloorAsk: Joi.boolean()
        .when("normalizeRoyalties", {
          is: Joi.boolean().valid(true),
          then: Joi.valid(false),
        })
        .default(false)
        .description(
          "If true, return the non flagged floor ask. Supported only when `normalizeRoyalties` is false."
        ),
    }),
  },
  response: {
    schema: Joi.object({
      collections: Joi.array().items(
        Joi.object({
          id: Joi.string().description("Collection id"),
          name: Joi.string().allow("", null),
          image: Joi.string().allow("", null),
          banner: Joi.string().allow("", null),
          description: Joi.string().allow("", null),
          primaryContract: Joi.string().lowercase().pattern(regex.address),
          count: Joi.number().integer(),
          volume: Joi.number(),
          floorAsk: {
            id: Joi.string().allow(null),
            sourceDomain: Joi.string().allow("", null),
            price: JoiPrice.allow(null),
            maker: Joi.string().lowercase().pattern(regex.address).allow(null),
            validFrom: Joi.number().unsafe().allow(null),
            validUntil: Joi.number().unsafe().allow(null),
            token: Joi.object({
              contract: Joi.string().lowercase().pattern(regex.address).allow(null),
              tokenId: Joi.string().pattern(regex.number).allow(null),
              name: Joi.string().allow(null),
              image: Joi.string().allow("", null),
            })
              .allow(null)
              .description("Lowest Ask Price."),
          },
          tokenCount: Joi.number().description("Total tokens within the collection."),
          ownerCount: Joi.number().description("Unique number of owners."),
          volumeChange: Joi.object({
            "1day": Joi.number().unsafe().allow(null),
            "7day": Joi.number().unsafe().allow(null),
            "30day": Joi.number().unsafe().allow(null),
          }).description(
            "Total volume change X-days vs previous X-days. (e.g. 7day [days 1-7] vs 7day prior [days 8-14]). A value over 1 is a positive gain, under 1 is a negative loss. e.g. 1 means no change; 1.1 means 10% increase; 0.9 means 10% decrease."
          ),
        })
      ),
    }).label(`getTopSellingCollections${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(
        `get-top-selling-collections-${version}-handler`,
        `Wrong response schema: ${error}`
      );
      throw error;
    },
  },
  handler: async (request: Request, h) => {
    const { fillType, limit, sortBy, normalizeRoyalties, useNonFlaggedFloorAsk } = request.query;

    try {
      let collectionsResult = [];
      const period = request.query.period === "24h" ? "1d" : request.query.period;

      const cacheKey = `topSellingCollections:v2:${period}:${fillType}:${sortBy}`;

      const cachedResults = await redis.get(cacheKey);

      if (cachedResults) {
        collectionsResult = JSON.parse(cachedResults).slice(0, limit);
      } else {
        const startTime = getStartTime(period);

        collectionsResult = await getTopSellingCollections({
          startTime,
          fillType,
          limit,
          sortBy,
        });
      }

      const collectionIds = collectionsResult.map((collection: any) => collection.id);
      const collectionsToFetch = collectionIds.map((id: string) => `collectionCache:v1:${id}`);

      const collectionMetadataCache = await redis
        .mget(collectionsToFetch)
        .then((results) =>
          results.filter((result) => !!result).map((result: any) => JSON.parse(result))
        );

      logger.info(
        "top-selling-collections",
        `using ${collectionMetadataCache.length} collections from cache`
      );

      const collectionsToFetchFromDb = collectionIds.filter((id: string) => {
        return !collectionMetadataCache.find((cache: any) => cache.id === id);
      });

      let collectionMetadataResponse: any = [];
      if (collectionsToFetchFromDb.length > 0) {
        logger.info(
          "top-selling-collections",
          `Fetching ${collectionsToFetchFromDb.length} collections from DB`
        );
        let floorAskSelectQuery;

        if (normalizeRoyalties) {
          floorAskSelectQuery = `
            collections.normalized_floor_sell_id AS floor_sell_id,
            collections.normalized_floor_sell_value AS floor_sell_value,
            collections.normalized_floor_sell_maker AS floor_sell_maker,
            least(2147483647::NUMERIC, date_part('epoch', lower(collections.normalized_floor_sell_valid_between)))::INT AS floor_sell_valid_from,
            least(2147483647::NUMERIC, coalesce(nullif(date_part('epoch', upper(collections.normalized_floor_sell_valid_between)), 'Infinity'),0))::INT AS floor_sell_valid_until,
            collections.normalized_floor_sell_source_id_int AS floor_sell_source_id_int
            `;
        } else if (useNonFlaggedFloorAsk) {
          floorAskSelectQuery = `
            collections.non_flagged_floor_sell_id AS floor_sell_id,
            collections.non_flagged_floor_sell_value AS floor_sell_value,
            collections.non_flagged_floor_sell_maker AS floor_sell_maker,
            least(2147483647::NUMERIC, date_part('epoch', lower(collections.non_flagged_floor_sell_valid_between)))::INT AS floor_sell_valid_from,
            least(2147483647::NUMERIC, coalesce(nullif(date_part('epoch', upper(collections.non_flagged_floor_sell_valid_between)), 'Infinity'),0))::INT AS floor_sell_valid_until,
            collections.non_flagged_floor_sell_source_id_int AS floor_sell_source_id_int
            `;
        } else {
          floorAskSelectQuery = `
            collections.floor_sell_id,
            collections.floor_sell_value,
            collections.floor_sell_maker,
            least(2147483647::NUMERIC, date_part('epoch', lower(collections.floor_sell_valid_between)))::INT AS floor_sell_valid_from,
            least(2147483647::NUMERIC, coalesce(nullif(date_part('epoch', upper(collections.floor_sell_valid_between)), 'Infinity'),0))::INT AS floor_sell_valid_until,
            collections.floor_sell_source_id_int
      `;
        }

        const collectionIdList = collectionsToFetchFromDb.map((id: string) => `'${id}'`).join(", ");

        const baseQuery = `
        SELECT
          collections.id,
          collections.name,
          collections.contract,
          collections.token_count,
          collections.owner_count,
          collections.day1_volume_change,
          collections.day7_volume_change,
          collections.day30_volume_change,
          (collections.metadata ->> 'imageUrl')::TEXT,
          (collections.metadata ->> 'bannerImageUrl')::TEXT AS "banner",
          (collections.metadata ->> 'description')::TEXT AS "description",
          ${floorAskSelectQuery}
        FROM collections
        WHERE collections.id IN (${collectionIdList})
      `;

        collectionMetadataResponse = await redb.manyOrNone(baseQuery);

        const redisMulti = redis.multi();

        for (const metadata of collectionMetadataResponse) {
          redisMulti.set(`collectionCache:v1:${metadata.id}`, JSON.stringify(metadata));

          redisMulti.expire(`collectionCache:v1:${metadata.id}`, 60 * 60 * 24);
        }
        await redisMulti.exec();
      }

      const collectionsMetadata: Record<string, any> = {};
      [...collectionMetadataResponse, ...collectionMetadataCache].forEach((metadata: any) => {
        collectionsMetadata[metadata.id] = metadata;
      });
      const sources = await Sources.getInstance();

      const collections = await Promise.all(
        collectionsResult.map(async (response: any) => {
          const metadata = collectionsMetadata[response.id] || {};
          let floorAsk;
          if (metadata) {
            const floorAskCurrency = metadata.floor_sell_currency
              ? fromBuffer(metadata.floor_sell_currency)
              : Sdk.Common.Addresses.Native[config.chainId];
            floorAsk = {
              id: metadata.floor_sell_id,
              sourceDomain: sources.get(metadata.floor_sell_source_id_int)?.domain,
              price: metadata.floor_sell_id
                ? await getJoiPriceObject(
                    {
                      gross: {
                        amount: metadata.floor_sell_currency_value ?? metadata.floor_sell_value,
                        nativeAmount: metadata.floor_sell_value,
                      },
                    },
                    floorAskCurrency
                  )
                : null,
            };
          }

          return {
            ...response,
            image: metadata.imageUrl,
            volumeChange: {
              "1day": metadata.day1_volume_change,
              "7day": metadata.day7_volume_change,
              "30day": metadata.day30_volume_change,
            },
            tokenCount: Number(metadata.token_count || 0),
            ownerCount: Number(metadata.owner_count || 0),
            banner: metadata.banner,
            description: metadata.description,
            floorAsk,
          };
        })
      );

      const response = h.response({ collections });
      return response;
    } catch (error) {
      logger.error(`get-top-selling-collections-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};