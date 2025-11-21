/**
 * WordPress REST API Utility Functions
 */

/**
 * Normalize WordPress-specific invalid types to standard JSON Schema types
 * WordPress REST API often uses format strings as types (date, email, uri, etc.)
 * which are not valid JSON Schema type values
 *
 * @param {string|array} type - Type value(s) to normalize
 * @returns {string|array} Normalized type value(s)
 */
export const normalizeWordPressType = (type) => {
	if (Array.isArray(type)) {
		return type.map((t) => normalizeWordPressType(t));
	}

	const typeReplacements = {
		date: 'string',
		'date-time': 'string',
		email: 'string',
		hostname: 'string',
		ipv4: 'string',
		ipv6: 'string',
		uri: 'string',
		url: 'string',
		mixed: 'string',
		bool: 'boolean',
	};

	return typeReplacements[type] || type;
};

/**
 * Normalize enum values by removing duplicates and converting associative arrays
 * WordPress sometimes provides malformed enum values
 *
 * @param {array} enumValues - Enum values to normalize
 * @returns {array} Normalized enum values
 */
export const normalizeEnum = (enumValues) => {
	if (!Array.isArray(enumValues)) {
		return enumValues;
	}

	// Remove duplicates and convert to array of values
	return [...new Set(enumValues)];
};

/**
 * Check if a route is a WordPress core collection endpoint
 * Collection endpoints return arrays of items, not single objects
 *
 * @param {string} route - WordPress route path
 * @returns {boolean} True if route is a collection endpoint
 */
export const isCollectionEndpoint = (route) => {
	const collectionEndpoints = [
		'/wp/v2/posts',
		'/wp/v2/pages',
		'/wp/v2/media',
		'/wp/v2/menu-items',
		'/wp/v2/blocks',
		'/wp/v2/templates',
		'/wp/v2/template-parts',
		'/wp/v2/navigation',
		'/wp/v2/font-families',
		'/wp/v2/categories',
		'/wp/v2/tags',
		'/wp/v2/menus',
		'/wp/v2/wp_pattern_category',
		'/wp/v2/users',
		'/wp/v2/comments',
		'/wp/v2/search',
		'/wp/v2/block-types',
		'/wp/v2/themes',
		'/wp/v2/plugins',
		'/wp/v2/sidebars',
		'/wp/v2/widget-types',
		'/wp/v2/widgets',
		'/wp/v2/block-directory/search',
		'/wp/v2/pattern-directory/patterns',
		'/wp/v2/block-patterns/patterns',
		'/wp/v2/block-patterns/categories',
		'/wp/v2/font-collections',
		'/wp/v2/posts/{parent}/revisions',
		'/wp/v2/posts/{id}/autosaves',
		'/wp/v2/pages/{parent}/revisions',
		'/wp/v2/pages/{id}/autosaves',
		'/wp/v2/menu-items/{id}/autosaves',
		'/wp/v2/blocks/{parent}/revisions',
		'/wp/v2/blocks/{id}/autosaves',
		'/wp/v2/templates/{parent}/revisions',
		'/wp/v2/templates/{id}/autosaves',
		'/wp/v2/template-parts/{parent}/revisions',
		'/wp/v2/template-parts/{id}/autosaves',
		'/wp/v2/global-styles/{parent}/revisions',
		'/wp/v2/global-styles/themes/{stylesheet}/variations',
		'/wp/v2/navigation/{parent}/revisions',
		'/wp/v2/navigation/{id}/autosaves',
		'/wp/v2/font-families/{font_family_id}/font-faces',
		'/wp/v2/users/{user_id}/application-passwords',
	];

	// Convert WordPress regex pattern to simple path for comparison
	const simplePath = route.replace(/\(\?P<\w+>[^)]+\)/g, '{param}');

	return collectionEndpoints.some((endpoint) => {
		const endpointPattern = endpoint.replace(/\{[\w_]+\}/g, '{param}');
		return simplePath === endpointPattern;
	});
};

/**
 * Clean WordPress schema properties by removing WordPress-specific keys
 * that are not part of standard JSON Schema
 *
 * @param {Object} properties - Schema properties object
 * @returns {Object} Cleaned properties object
 */
export const cleanWordPressSchemaProperties = (properties) => {
	if (!properties || typeof properties !== 'object') {
		return properties;
	}

	const keysToRemove = ['context', 'readonly'];
	const cleaned = {};

	Object.keys(properties).forEach((key) => {
		if (keysToRemove.includes(key)) {
			return; // Skip this property
		}

		let value = properties[key];

		// Recursively clean nested objects
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			value = cleanWordPressSchemaProperties(value);
		}

		// Recursively clean arrays
		if (Array.isArray(value)) {
			value = value.map((item) => {
				if (typeof item === 'object' && item !== null) {
					return cleanWordPressSchemaProperties(item);
				}
				return item;
			});
		}

		cleaned[key] = value;
	});

	return cleaned;
};

/**
 * Extract JSON Schema validation constraints from WordPress args
 * Returns an object with validation properties like minLength, maxLength, enum, etc.
 *
 * @param {Object} args - WordPress endpoint arguments
 * @returns {Object} Validation constraints
 */
export const extractValidationConstraints = (args) => {
	const constraints = {};

	const supportedConstraints = [
		'minLength',
		'maxLength',
		'minimum',
		'maximum',
		'minItems',
		'maxItems',
		'uniqueItems',
		'enum',
		'format',
		'pattern',
		'multipleOf',
	];

	supportedConstraints.forEach((constraint) => {
		if (args[constraint] !== undefined) {
			constraints[constraint] = args[constraint];
		}
	});

	// Normalize enum if present
	if (constraints.enum) {
		constraints.enum = normalizeEnum(constraints.enum);
	}

	return constraints;
};

/**
 * Determine parameter location based on HTTP method and parameter name
 * GET requests use query params, other methods use request body (except path params)
 *
 * @param {string} method - HTTP method
 * @param {string} paramName - Parameter name
 * @param {array} pathParams - List of path parameter names
 * @returns {string} Parameter location: 'path', 'query', or 'body'
 */
export const getParameterLocation = (method, paramName, pathParams = []) => {
	// Path parameters are always in the path
	if (pathParams.includes(paramName)) {
		return 'path';
	}

	// GET requests use query parameters
	if (method.toUpperCase() === 'GET') {
		return 'query';
	}

	// Other methods (POST, PUT, PATCH, DELETE) use request body
	return 'body';
};

/**
 * Extract path parameters from WordPress route pattern
 * Converts (?P<id>\\d+) to 'id'
 *
 * @param {string} route - WordPress route pattern
 * @returns {array} List of path parameter names
 */
export const extractPathParameters = (route) => {
	const pathParams = [];
	const regex = /\(\?P<(\w+)>[^)]+\)/g;

	for (const match of route.matchAll(regex)) {
		pathParams.push(match[1]);
	}

	return pathParams;
};

/**
 * Check if a parameter should be marked as required
 * Path parameters are always required
 *
 * @param {Object} argDef - Argument definition from WordPress
 * @param {boolean} isPathParam - Whether this is a path parameter
 * @returns {boolean} True if parameter is required
 */
export const isParameterRequired = (argDef, isPathParam) => {
	if (isPathParam) {
		return true;
	}

	// WordPress uses 'required' field
	if (typeof argDef.required === 'boolean') {
		return argDef.required;
	}

	return false;
};
