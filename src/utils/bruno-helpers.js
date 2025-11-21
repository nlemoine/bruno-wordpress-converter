import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { collectionSchema } = require('@usebruno/schema');
const each = require('lodash/each');
const get = require('lodash/get');

/**
 * Validate collection against Bruno schema
 * Adapted from @usebruno/converters/src/common
 */
export const validateSchema = (collection = {}) => {
	try {
		collectionSchema.validateSync(collection);
		return collection;
	} catch (err) {
		console.log('Error validating schema', err);
		throw new Error('The Collection has an invalid schema');
	}
};

/**
 * Check if item is a request
 */
export const isItemARequest = (item) => {
	return (
		Object.hasOwn(item, 'request') &&
		['http-request', 'graphql-request'].includes(item.type) &&
		!item.items
	);
};

/**
 * Transform items in collection - convert query params and handle types
 * Adapted from @usebruno/converters/src/common
 */
export const transformItemsInCollection = (collection) => {
	const transformItems = (items = []) => {
		each(items, (item) => {
			if (['http', 'graphql'].includes(item.type)) {
				item.type = `${item.type}-request`;

				if (item.request.query) {
					item.request.params = item.request.query.map((queryItem) => ({
						...queryItem,
						type: 'query',
					}));
				}

				delete item.request.query;

				// Handle multipartForm type
				const multipartFormData = get(item, 'request.body.multipartForm');
				if (multipartFormData) {
					each(multipartFormData, (form) => {
						if (!form.type) {
							form.type = 'text';
						}
					});
				}
			}

			if (item.items?.length) {
				transformItems(item.items);
			}
		});
	};

	transformItems(collection.items);

	return collection;
};

/**
 * Hydrate sequence numbers in collection
 * Adapted from @usebruno/converters/src/common
 */
export const hydrateSeqInCollection = (collection) => {
	const hydrateSeq = (items = []) => {
		let index = 1;
		each(items, (item) => {
			if (isItemARequest(item) && !item.seq) {
				item.seq = index;
				index++;
			}
			if (item.items?.length) {
				hydrateSeq(item.items);
			}
		});
	};
	hydrateSeq(collection.items);

	return collection;
};
