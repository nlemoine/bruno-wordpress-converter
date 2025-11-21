import https from 'node:https';
import { createRequire } from 'node:module';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { customAlphabet } from 'nanoid';
import fetch from 'node-fetch';
import {
	hydrateSeqInCollection,
	transformItemsInCollection,
	validateSchema,
} from '../utils/bruno-helpers.js';
import {
	extractPathParameters,
	extractValidationConstraints,
	getParameterLocation,
	isCollectionEndpoint,
	isParameterRequired,
	normalizeEnum,
	normalizeWordPressType,
} from '../utils/wordpress-utils.js';

const require = createRequire(import.meta.url);

const each = require('lodash/each');

// UUID generator from Bruno converters
const urlAlphabet =
	'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict';
const uuid = customAlphabet(urlAlphabet, 21);

/**
 * Create Basic Authentication header value
 * @param {string} username - WordPress username
 * @param {string} password - WordPress application password
 * @returns {string} Base64 encoded auth header value
 */
const createBasicAuthHeader = (username, password) => {
	// Remove spaces from application password (WordPress formats them with spaces for readability)
	const cleanPassword = password.replace(/\s+/g, '');
	const credentials = `${username}:${cleanPassword}`;
	return `Basic ${Buffer.from(credentials).toString('base64')}`;
};

/**
 * Get appropriate agent for fetch requests
 * Handles both SSL certificate issues and HTTP proxy configuration
 * @param {string} url - The URL being fetched
 * @param {boolean} rejectUnauthorized - Whether to reject unauthorized SSL certificates (default: true for security)
 * @returns {Agent|undefined} HTTPS agent with proxy/SSL config, or undefined for HTTP
 */
const getAgent = (url, rejectUnauthorized = true) => {
	if (!url.startsWith('https:')) {
		return undefined;
	}

	const proxyUrl =
		process.env.HTTP_PROXY ||
		process.env.http_proxy ||
		process.env.HTTPS_PROXY ||
		process.env.https_proxy;

	if (proxyUrl) {
		// For HttpsProxyAgent v7+, pass a second options object with TLS settings
		// The agent will apply these to the connection to the target server
		return new HttpsProxyAgent(proxyUrl, {
			// TLS options for connecting to the target server through the proxy
			rejectUnauthorized: rejectUnauthorized,
		});
	}

	// Default HTTPS agent for non-proxy connections
	return new https.Agent({
		rejectUnauthorized,
	});
};

/**
 * Fetch WordPress REST API schema from a given URL
 * @param {string} wpApiUrl - WordPress REST API base URL (e.g., https://example.com/wp-json/)
 * @param {Object} options - Fetch options including rejectUnauthorized, username, password
 * @returns {Promise<Object>} WordPress REST API index response
 */
const fetchWordPressSchema = async (wpApiUrl, options = {}) => {
	const url = wpApiUrl.endsWith('/') ? wpApiUrl : `${wpApiUrl}/`;
	const {
		rejectUnauthorized = true,
		username,
		password,
		...fetchOptions
	} = options;

	const headers = {};
	if (username && password) {
		headers.Authorization = createBasicAuthHeader(username, password);
	}

	try {
		const response = await fetch(url, {
			agent: getAgent(url, rejectUnauthorized),
			headers,
			...fetchOptions,
		});

		if (!response.ok) {
			throw new Error(
				`Failed to fetch WordPress API index: ${response.statusText}`,
			);
		}
		return await response.json();
	} catch (error) {
		throw new Error(`Error fetching WordPress schema: ${error.message}`);
	}
};

/**
 * Fetch detailed schema for a specific route using OPTIONS request
 * @param {string} wpApiUrl - WordPress REST API base URL
 * @param {string} route - The route to fetch schema for
 * @param {Object} options - Options including rejectUnauthorized, username, password
 * @returns {Promise<Object>} Detailed route schema
 */
const fetchRouteSchema = async (wpApiUrl, route, options = {}) => {
	const { rejectUnauthorized = true, username, password } = options;
	const baseUrl = wpApiUrl.endsWith('/') ? wpApiUrl.slice(0, -1) : wpApiUrl;
	const url = `${baseUrl}${route}`;

	try {
		const headers = {};
		if (username && password) {
			headers.Authorization = createBasicAuthHeader(username, password);
		}

		const fetchOptions = {
			method: 'OPTIONS',
			agent: getAgent(url, rejectUnauthorized),
			headers,
		};

		const response = await fetch(url, fetchOptions);
		if (!response.ok) {
			console.warn(
				`Failed to fetch schema for ${route}: ${response.statusText}`,
			);
			return null;
		}
		return await response.json();
	} catch (error) {
		console.warn(`Error fetching schema for ${route}:`, error.message);
		return null;
	}
};

/**
 * Generate example value based on WordPress schema property
 * @param {Object} property - Schema property definition
 * @param {string} name - Property name for contextual examples
 * @returns {*} Example value
 */
const generateExampleValue = (property, name) => {
	// Use enum value if available
	if (property.enum && property.enum.length > 0) {
		return property.enum[0];
	}

	// Use default if provided
	if (property.default !== undefined) {
		return property.default;
	}

	// Normalize WordPress-specific types
	const normalizedType = normalizeWordPressType(property.type || 'string');

	// Generate based on normalized type
	switch (normalizedType) {
		case 'integer':
			return 0;
		case 'number':
			return 0.0;
		case 'boolean':
			return false;
		case 'array':
			return [];
		case 'object':
			// Generate nested object if properties are defined
			if (property.properties) {
				const obj = {};
				each(property.properties, (prop, propName) => {
					obj[propName] = generateExampleValue(prop, propName);
				});
				return obj;
			}
			return {};
		default:
			// Contextual string examples for common WordPress fields
			if (name === 'status') return 'publish';
			if (name === 'title' || name === 'name') return 'Example Title';
			if (name === 'content') return 'Example content';
			if (name === 'excerpt') return 'Example excerpt';
			if (name === 'slug') return 'example-slug';
			if (name === 'password') return '';
			if (name === 'author') return 1;
			if (property.format === 'date-time') return new Date().toISOString();
			if (property.format === 'uri') return 'https://example.com';
			return '';
	}
};

/**
 * Generate request body JSON from WordPress endpoint args and schema
 * @param {Object} args - WordPress endpoint arguments
 * @param {Object} schema - WordPress resource schema
 * @param {string} method - HTTP method
 * @param {Array} pathParams - List of path parameter names
 * @returns {string} JSON string for request body
 */
const generateRequestBody = (args, schema, method, pathParams = []) => {
	const body = {};

	// For POST/PUT/PATCH/DELETE, process args that should go in the body
	if (args) {
		each(args, (arg, argName) => {
			// Skip context and path parameters
			if (argName === 'context' || pathParams.includes(argName)) {
				return;
			}

			// Skip read-only properties
			if (arg.readonly === true) {
				return;
			}

			// For body parameters, generate example values
			const location = getParameterLocation(method, argName, pathParams);
			if (location === 'body') {
				// Normalize type
				const normalizedType = normalizeWordPressType(arg.type || 'string');

				// Create property definition for example generation
				const property = {
					type: normalizedType,
					default: arg.default,
					enum: arg.enum ? normalizeEnum(arg.enum) : undefined,
					format: arg.format,
				};

				body[argName] = generateExampleValue(property, argName);
			}
		});
	}

	// If we have a schema, try to add common writable fields from it
	if (schema?.properties) {
		each(schema.properties, (property, name) => {
			// Skip if already added from args or read-only
			if (body[name] !== undefined || property.readonly === true) {
				return;
			}

			// Include common writable fields for context
			const isCommon = [
				'title',
				'content',
				'excerpt',
				'status',
				'author',
				'slug',
				'password',
				'name',
				'description',
			].includes(name);
			if (isCommon) {
				body[name] = generateExampleValue(property, name);
			}
		});
	}

	return Object.keys(body).length > 0 ? JSON.stringify(body, null, 2) : null;
};

/**
 * Transform WordPress route and method to Bruno request item
 * @param {string} route - WordPress route path
 * @param {string} method - HTTP method
 * @param {Object} endpoint - Endpoint configuration from WordPress schema
 * @param {Object} schema - Resource schema
 * @param {string} baseUrl - Base WordPress API URL
 * @returns {Object} Bruno request item
 */
const transformWordPressEndpoint = (
	route,
	method,
	endpoint,
	schema,
	_baseUrl,
) => {
	const methodUpper = method.toUpperCase();
	const args = endpoint.args || {};

	// Generate request name based on method and route
	const resourceMatch = route.match(/\/wp\/v2\/(\w+)/);
	const resource = resourceMatch ? resourceMatch[1] : 'resource';
	const hasIdParam = route.includes('(?P<');

	// Check if this is a special nested route (revisions, autosaves, etc.)
	const isAutosave = route.includes('autosaves');
	const isRevision = route.includes('revisions');

	// Check if this is a collection endpoint
	const isCollection = isCollectionEndpoint(route);

	let name;
	switch (methodUpper) {
		case 'GET':
			if (isAutosave) {
				name =
					hasIdParam && route.match(/autosaves\/\(\?P<id>/i)
						? `Get ${resource} autosave by ID`
						: `List ${resource} autosaves`;
			} else if (isRevision) {
				name =
					hasIdParam && route.match(/revisions\/\(\?P<id>/i)
						? `Get ${resource} revision by ID`
						: `List ${resource} revisions`;
			} else if (hasIdParam) {
				name = `Get ${resource} by ID`;
			} else if (isCollection) {
				name = `List ${resource}`;
			} else {
				name = `Get ${resource}`;
			}
			break;
		case 'POST':
			if (isAutosave) {
				name = `Create ${resource} autosave`;
			} else if (isRevision) {
				name = `Create ${resource} revision`;
			} else {
				name = `Create ${resource}`;
			}
			break;
		case 'PUT':
		case 'PATCH':
			name = `Update ${resource}`;
			break;
		case 'DELETE':
			if (isAutosave) {
				name = `Delete ${resource} autosave`;
			} else if (isRevision) {
				name = `Delete ${resource} revision`;
			} else {
				name = `Delete ${resource}`;
			}
			break;
		default:
			name = `${methodUpper} ${route}`;
	}

	// Convert WordPress route pattern to Bruno URL format
	// Replace (?P<id>\\d+) with :id
	const brunoUrl = route.replace(/\(\?P<(\w+)>[^)]+\)/g, ':$1');

	const brunoRequestItem = {
		uid: uuid(),
		name: name,
		type: 'http-request',
		seq: 1,
		request: {
			url: `{{baseUrl}}${brunoUrl}`,
			method: methodUpper,
			auth: {
				mode: 'inherit',
				basic: null,
				bearer: null,
			},
			headers: [],
			params: [],
			body: {
				mode: 'none',
				json: null,
				text: null,
				xml: null,
				formUrlEncoded: [],
				multipartForm: [],
			},
			script: {},
			tests: '',
			vars: {
				req: [],
				res: [],
			},
			assertions: [],
		},
	};

	// Add Content-Type header for POST/PUT/PATCH requests
	if (['POST', 'PUT', 'PATCH'].includes(methodUpper)) {
		brunoRequestItem.request.headers.push({
			uid: uuid(),
			name: 'Content-Type',
			value: 'application/json',
			description: '',
			enabled: true,
		});
	}

	// Extract path parameters from the route
	const pathParams = extractPathParameters(route);

	// Process arguments to populate params and body
	each(args, (arg, argName) => {
		// Skip 'context' argument - it's WordPress-specific and not needed in Bruno
		if (argName === 'context') {
			return;
		}

		// Determine parameter location
		const location = getParameterLocation(methodUpper, argName, pathParams);

		if (location === 'path') {
			// Path parameters are always required and included in URL
			brunoRequestItem.request.params.push({
				uid: uuid(),
				name: argName,
				value: '',
				description: arg.description || '',
				enabled: true,
				type: 'path',
			});
		} else if (location === 'query') {
			// Query parameters for GET requests
			const defaultValue = arg.default !== undefined ? String(arg.default) : '';
			const isRequired = isParameterRequired(arg, false);

			// Extract validation constraints
			const constraints = extractValidationConstraints(arg);
			let description = arg.description || '';

			// Add validation info to description
			if (constraints.enum) {
				description += description ? '. ' : '';
				description += `Allowed values: ${constraints.enum.join(', ')}`;
			}
			if (constraints.minLength || constraints.maxLength) {
				description += description ? '. ' : '';
				if (constraints.minLength)
					description += `Min length: ${constraints.minLength}`;
				if (constraints.minLength && constraints.maxLength) description += ', ';
				if (constraints.maxLength)
					description += `Max length: ${constraints.maxLength}`;
			}

			brunoRequestItem.request.params.push({
				uid: uuid(),
				name: argName,
				value: defaultValue,
				description: description,
				enabled: isRequired, // Enable required params, disable optional
				type: 'query',
			});
		}
		// For body parameters (POST/PUT/PATCH/DELETE), they'll be handled in generateRequestBody
	});

	// Add common WordPress query parameters for GET list requests
	if (methodUpper === 'GET' && !hasIdParam) {
		const commonParams = [
			{
				name: 'page',
				value: '1',
				description: 'Current page of the collection',
			},
			{
				name: 'per_page',
				value: '10',
				description: 'Maximum number of items to be returned',
			},
			{
				name: 'search',
				value: '',
				description: 'Limit results to those matching a string',
			},
			{
				name: 'orderby',
				value: 'date',
				description: 'Sort collection by object attribute',
			},
			{
				name: 'order',
				value: 'desc',
				description: 'Order sort attribute ascending or descending',
			},
		];

		commonParams.forEach((param) => {
			// Only add if not already present
			if (!brunoRequestItem.request.params.find((p) => p.name === param.name)) {
				brunoRequestItem.request.params.push({
					uid: uuid(),
					name: param.name,
					value: param.value,
					description: param.description,
					enabled: false,
					type: 'query',
				});
			}
		});

		// Add _embed parameter for embedded responses
		brunoRequestItem.request.params.push({
			uid: uuid(),
			name: '_embed',
			value: '1',
			description: 'Include embedded resources in response',
			enabled: false,
			type: 'query',
		});
	}

	// Generate request body for POST/PUT/PATCH requests
	if (['POST', 'PUT', 'PATCH'].includes(methodUpper)) {
		const bodyJson = generateRequestBody(args, schema, methodUpper, pathParams);

		if (bodyJson) {
			brunoRequestItem.request.body.mode = 'json';
			brunoRequestItem.request.body.json = bodyJson;
		}
	}

	// Add basic tests
	let tests = `test("Status code is ${methodUpper === 'POST' ? '201' : '200'}", function() {
  expect(res.status).to.equal(${methodUpper === 'POST' ? '201' : '200'});
});`;

	// Add collection-specific tests for GET list endpoints
	if (methodUpper === 'GET' && isCollection && !hasIdParam) {
		tests += `

test("Response is an array", function() {
  expect(res.body).to.be.an('array');
});`;
	}

	brunoRequestItem.request.tests = tests;

	return brunoRequestItem;
};

/**
 * Organize endpoints into folders by namespace and resource
 * @param {Array} items - Array of Bruno request items
 * @returns {Array} Organized items with nested folders
 */
const organizeIntoFolders = (items) => {
	const namespaceMap = new Map();

	items.forEach((item) => {
		// Extract namespace and resource from URL
		const urlMatch = item.request.url.match(/\/([^/]+\/v\d+)\/([^/:?]+)/);
		if (urlMatch) {
			const namespace = urlMatch[1]; // e.g., "wp/v2"
			const resource = urlMatch[2]; // e.g., "posts"

			// Create namespace folder if it doesn't exist
			if (!namespaceMap.has(namespace)) {
				namespaceMap.set(namespace, {
					uid: uuid(),
					name: namespace.replace(/\//g, '-'), // "wp/v2" -> "wp-v2"
					type: 'folder',
					items: [],
				});
			}

			const namespaceFolder = namespaceMap.get(namespace);

			// Find or create resource folder within namespace
			let resourceFolder = namespaceFolder.items.find(
				(folder) => folder.type === 'folder' && folder.name === resource,
			);

			if (!resourceFolder) {
				resourceFolder = {
					uid: uuid(),
					name: resource,
					type: 'folder',
					items: [],
				};
				namespaceFolder.items.push(resourceFolder);
			}

			resourceFolder.items.push(item);
		}
	});

	return Array.from(namespaceMap.values());
};

/**
 * Main function to convert WordPress REST API to Bruno collection
 * @param {string} wpApiUrl - WordPress REST API base URL
 * @param {Object} options - Conversion options
 * @returns {Promise<Object>} Bruno collection object
 */
const wordpressToBruno = async (wpApiUrl, options = {}) => {
	const {
		collectionName = 'WordPress API Collection',
		includeNamespaces = null, // null = include all
		excludeRoutes = [],
		fetchSchemas = true,
		rejectUnauthorized = true,
		username,
		password,
	} = options;

	// Normalize URL
	const baseUrl = wpApiUrl.endsWith('/') ? wpApiUrl.slice(0, -1) : wpApiUrl;

	console.log(`Fetching WordPress API schema from ${baseUrl}...`);

	// Fetch the main API index
	const apiIndex = await fetchWordPressSchema(wpApiUrl, {
		rejectUnauthorized,
		username,
		password,
	});

	if (!apiIndex.routes) {
		throw new Error('Invalid WordPress REST API response - no routes found');
	}

	console.log(`Found ${Object.keys(apiIndex.routes).length} routes`);

	const brunoItems = [];
	const processedRoutes = new Set();

	// Process each route
	for (const [route, routeData] of Object.entries(apiIndex.routes)) {
		// Skip if already processed or excluded
		if (processedRoutes.has(route) || excludeRoutes.includes(route)) {
			continue;
		}

		// Filter by namespace if specified
		if (includeNamespaces) {
			const namespaceMatch =
				routeData.namespace || route.match(/^\/([^/]+\/v\d+)/)?.[1];
			if (!namespaceMatch || !includeNamespaces.includes(namespaceMatch)) {
				continue;
			}
		}

		// Fetch detailed schema if requested
		let detailedSchema = null;
		if (fetchSchemas) {
			detailedSchema = await fetchRouteSchema(baseUrl, route, {
				rejectUnauthorized,
				username,
				password,
			});
		}

		// Get schema from either detailed fetch or main index
		const schema = detailedSchema?.schema || routeData.schema || null;
		const endpoints = detailedSchema?.endpoints || routeData.endpoints || [];

		// Process each endpoint (method) for this route
		endpoints.forEach((endpoint) => {
			const methods = endpoint.methods || [];

			methods.forEach((method) => {
				// Skip OPTIONS and HEAD methods
				if (['OPTIONS', 'HEAD'].includes(method)) {
					return;
				}

				try {
					const brunoItem = transformWordPressEndpoint(
						route,
						method,
						endpoint,
						schema,
						baseUrl,
					);

					brunoItems.push(brunoItem);
				} catch (error) {
					console.error(`Error processing ${method} ${route}:`, error.message);
				}
			});
		});

		processedRoutes.add(route);
	}

	console.log(`Generated ${brunoItems.length} Bruno requests`);

	// Organize into folders
	const organizedItems = organizeIntoFolders(brunoItems);

	// Build Bruno collection
	const brunoCollection = {
		version: '1',
		uid: uuid(),
		name: collectionName,
		items: organizedItems,
		environments: [],
	};

	// Add default environment with baseUrl
	brunoCollection.environments.push({
		uid: uuid(),
		name: 'Default',
		variables: [
			{
				uid: uuid(),
				name: 'baseUrl',
				value: baseUrl,
				type: 'text',
				enabled: true,
				secret: false,
			},
			{
				uid: uuid(),
				name: 'username',
				value: '',
				type: 'text',
				enabled: true,
				secret: false,
			},
			{
				uid: uuid(),
				name: 'password',
				value: '',
				type: 'text',
				enabled: true,
				secret: true,
			},
		],
	});

	console.log('Validating and transforming collection...');

	// Transform and validate using Bruno utilities
	const transformedCollection = transformItemsInCollection(brunoCollection);
	const hydratedCollection = hydrateSeqInCollection(transformedCollection);
	const validatedCollection = validateSchema(hydratedCollection);

	return validatedCollection;
};

export default wordpressToBruno;
