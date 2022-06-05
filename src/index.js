import { h, cloneElement, render, hydrate } from 'preact';

export default function register(Component, tagName, propNames, options) {
	function PreactElement() {
		const inst = Reflect.construct(HTMLElement, [], PreactElement);
		inst._vdomComponent = Component;
		inst._root =
			options && options.shadow ? inst.attachShadow({ mode: 'open' }) : inst;

		if (options && options.shadow && options.styles) {
			const $styles = document.createElement('style');
			$styles.textContent = options.styles;
			inst._root.appendChild($styles);
		}

		inst._props = {};
		inst._slots = {};

		// preact renderer registers all props prefixed with "on" as event listeners
		// and sets all listeners as "l" prop on the instance
		// instad of passing them to WC
		inst.l = new Proxy(
			{},
			{
				set(target, prop, val) {
					const name = `on${capitalize(prop)}`.replace(/(true)|(false)/, '');
					target[prop] = val;

					if (propNames.includes(name)) {
						// if it is observed attribute "remove" the handler
						// which preact renderer registered as handler for the native event
						// e.g. prevent onClick from being called twice when wc rendered in preact
						// target[prop] = () => null;

						const oldVal = inst._props[name];
						inst.attributeChangedCallback(toKebabCase(name), oldVal, val);
					}

					return true;
				},
			}
		);

		return inst;
	}

	PreactElement.prototype = Object.create(HTMLElement.prototype);
	PreactElement.prototype.constructor = PreactElement;
	PreactElement.prototype.connectedCallback = connectedCallback;
	PreactElement.prototype.attributeChangedCallback = attributeChangedCallback;
	PreactElement.prototype.disconnectedCallback = disconnectedCallback;

	propNames =
		propNames ||
		Component.observedAttributes ||
		Object.keys(Component.propTypes || {});

	propNames = Array.from(
		new Set([
			...propNames.map((p) => toCamelCase(p)),
			...propNames.map((p) => toKebabCase(p)),
		])
	);

	PreactElement.observedAttributes = Array.from(
		new Set(propNames.map((p) => toKebabCase(p)))
	);

	propNames.forEach((name) => {
		Object.defineProperty(PreactElement.prototype, name, {
			get() {
				return this._props[name];
			},
			set(v) {
				const oldVal = this._props[name] ?? null;

				if (isPrimitive(v)) {
					if (oldVal === v) return;
					// don't call attributeChanged here manually
					// just reflect it to attribute and let WC API call attributeChanged implicitly

					// html attributes are case insesitive,
					// convert to kebab-case just in case of camelCase
					this.setAttribute(toKebabCase(name), v);
				} else {
					// complex props cannot be reflected to attributes
					// trigger attributeChanged manually to re-render

					// convert to kebab-case to mimic how custom components
					// would call it, since attributes cannot be camelCase
					this.attributeChangedCallback(toKebabCase(name), oldVal, v);
				}
			},
		});
	});

	return customElements.define(
		tagName || Component.tagName || Component.displayName || Component.name,
		PreactElement
	);
}

function ContextProvider(props) {
	const { children, context } = props;
	this.getChildContext = () => context;
	return children;
}

ContextProvider.displayName = 'ContextProvider';

function connectedCallback() {
	// child element without slot attribute belongs to default slot
	// and will be provided as children prop
	// named slots will be provided as props named based on slot attribute value
	const { '': children, ...namedSlots } = getSlots(this);
	this._slots = { children, ...namedSlots };

	const event = new CustomEvent('_preact-ctx', {
		composed: true,
		bubbles: true,
		cancelable: true,
		detail: {},
	});

	// fire an event to obtain context
	// the listener in the parent will set the detail of the event to the context
	this._root.dispatchEvent(event);
	const context = event.detail.context;

	this._vdom = h(
		ContextProvider,
		{ context },
		h(this._vdomComponent, { ...this._props, ...this._slots })
	);

	(this.hasAttribute('hydrate') ? hydrate : render)(this._vdom, this._root);
}

function disconnectedCallback() {
	this._props = {};
	this._slots = {};
	render((this._vdom = null), this._root);
}

function attributeChangedCallback(name, oldVal, newVal) {
	// replace null by undefined
	newVal =
		newVal == null
			? undefined
			: isDomElement(newVal)
			? nodeToVNode(newVal)
			: newVal;

	if (newVal === oldVal) return;

	this._props[toCamelCase(name)] = newVal;
	// name is always kebab-case so no need to call toKebabCase()
	this._props[name] = newVal;

	// if it was not connected to dom yet
	// then no need to re-render yet
	// this happens when the element is created e.g. document.createElement('x-element');
	// but not appended to dom.
	// attributeChangedCallback will be still called if we set attributes or props on the instance
	if (!this._vdom) return;

	// each component is wrapped inside ContextProvider (to provide context over WC boundaries)
	// this._vdom is ContextProvider
	// we clone it to keep the context object (we provide null not to override it)
	// and as a child we provide the actual component with updated props
	this._vdom = cloneElement(
		this._vdom,
		null,
		h(this._vdomComponent, { ...this._props, ...this._slots })
	);
	render(this._vdom, this._root);
}

/**
 * @param prop
 * @return {Boolean}
 */
function isPrimitive(prop) {
	if (prop == null) return true;
	return ['string', 'boolean', 'number'].includes(typeof prop);
}

function isDomElement(obj) {
	return !!(obj && [Node.TEXT_NODE, Node.ELEMENT_NODE].includes(obj.nodeType));
}

/**
 * Return slots as vdom
 *
 * Example:
 * slots = {
 * 	'': VNode[], // slot without a name is default
 * 	header: VNode[]
 * }
 *
 * @param {HTMLElement} el
 */
function getSlots(el) {
	const slots = {};

	for (const childNode of el.childNodes) {
		if (!isDomElement(childNode)) continue;

		const slotName = childNode.slot; // child node without a slot attribute is ''
		if (!slots[slotName]) slots[slotName] = [];
		// create empty slot element for each child node
		// then we provide those empty slot elements as props to the component
		// and component decides where to place (render) them
		// the actual children will be slotted natively as specified in html standards
		const slot = h(Slot, { name: slotName || undefined });
		slots[slotName].push(slot);
	}

	return slots;
}

// Slot has access to context
// because parent of the Slot is wrapped by ContextProvider
// which provide context via getChildContext()
function Slot(props, context) {
	const ref = (el) => {
		if (!el) {
			this.el?.removeEventListener('_preact-ctx', this.listener);
		} else {
			this.el = el;
			if (!this.listener) {
				this.listener = (e) => {
					e.stopPropagation();
					// add context on the detail so emitter can read it
					e.detail.context = context;
				};
			}

			el.addEventListener('_preact-ctx', this.listener);
		}
	};

	// render native slot element with a name given in props
	return h('slot', { ...props, ref });
}

Slot.displayName = 'Slot';

/**
 * @param {String} str
 * @return {String}
 */
function toCamelCase(str) {
	return str.replace(/-(\w)/g, (_, c) => (c ? c.toUpperCase() : ''));
}

/**
 * @param {String} str
 * @return {String}
 */
function toKebabCase(str) {
	return str.replace(
		/[A-Z]+(?![a-z])|[A-Z]/g,
		($, c) => (c ? '-' : '') + $.toLowerCase()
	);
}

/**
 * @param {import('preact').VNode} node
 * @return {import('preact').VNode}
 */
function nodeToVNode(node) {
	if (node.nodeType === Node.TEXT_NODE) return node.data;
	if (node.nodeType !== Node.ELEMENT_NODE) return null;

	/** @type {Element} el */
	const el = node;

	let props = {};
	let children = [];

	for (const attr of el.attributes) {
		if (attr.name === 'slot') continue;

		props[attr.name] = attr.value;
	}

	for (let childNode of el.childNodes) {
		children.push(nodeToVNode(childNode));
	}

	return h(el.nodeName.toLowerCase(), props, children);
}

/**
 * Capitalize first letter
 * @param {String} str
 * @return {String}
 */
function capitalize(str) {
	return str.charAt(0).toUpperCase() + str.slice(1);
}
