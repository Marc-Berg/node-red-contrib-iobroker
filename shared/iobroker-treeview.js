/*!
 * ioBroker Hierarchical TreeView - Shared Component
 * Version: 1.0.0
 * Complete implementation with SSL support and wildcard detection
 */

(function(global) {
    'use strict';
    
    // Prevent multiple initialization
    if (typeof global.ioBrokerSharedTreeView !== 'undefined') return;
    
    const VIRTUAL_SCROLL_CONFIG = {
        ITEM_HEIGHT: 24,
        BUFFER_SIZE: 5,
        CHUNK_SIZE: 100,
        CACHE_DURATION: 5 * 60 * 1000
    };
    
    const stateCache = new Map();
    const performanceMetrics = {
        renderTime: 0,
        searchTime: 0,
        cacheHits: 0,
        cacheMisses: 0
    };
    
    // CSS Injection with versioning
    function injectStyles() {
        if (document.getElementById('iob-shared-styles-v1')) return;
        
        const style = document.createElement('style');
        style.id = 'iob-shared-styles-v1';
        style.textContent = `
            .iob-virtual-container {
                height: 320px;
                overflow-y: auto;
                overflow-x: hidden;
                border: 1px solid #ccc;
                border-radius: 4px;
                background: #fafafa;
                display: none;
                position: relative;
            }
            
            .iob-tree-content {
                padding: 4px;
            }
            
            .iob-tree-item {
                height: ${VIRTUAL_SCROLL_CONFIG.ITEM_HEIGHT}px;
                display: flex;
                align-items: center;
                padding: 0 8px;
                cursor: pointer;
                white-space: nowrap;
                border-radius: 3px;
                transition: background-color 0.15s ease;
                user-select: none;
                font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
                font-size: 13px;
                line-height: 1.2;
                box-sizing: border-box;
                margin-bottom: 1px;
            }
            
            .iob-tree-item:hover { background-color: #e8f4f8; }
            .iob-tree-item.selected { background-color: #d4edda; border-left: 3px solid #28a745; }
            .iob-tree-item.folder { font-weight: 500; }
            .iob-tree-item.search-match { background-color: #fff3cd; border-left: 2px solid #ffc107; }
            .iob-tree-item.search-match:hover { background-color: #ffeaa7; }
            .iob-tree-item.search-path { background-color: #f8f9fa; border-left: 1px solid #dee2e6; }
            
            .iob-tree-icon {
                display: inline-flex; width: 18px; height: 18px; align-items: center;
                justify-content: center; margin-right: 6px; font-size: 12px; flex-shrink: 0;
            }
            
            .iob-tree-label { flex: 1; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
            .iob-tree-label mark { background-color: #ffeb3b; padding: 1px 3px; border-radius: 2px; font-weight: bold; color: #333; }
            
            .iob-search-input {
                width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px;
                font-size: 14px; box-sizing: border-box; margin-bottom: 8px;
            }
            .iob-search-input:focus { outline: none; border-color: #4CAF50; box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.2); }
            
            .iob-status { padding: 6px 10px; border-radius: 3px; font-size: 12px; font-weight: 500; margin-top: 5px; display: inline-block; }
            .iob-status-success { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
            .iob-status-info { background-color: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
            .iob-status-error { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
            
            .iob-control-buttons { display: flex; gap: 8px; margin-top: 5px; }
            .iob-btn { padding: 6px 12px; border: 1px solid #ddd; border-radius: 4px; background: white; cursor: pointer; font-size: 12px; transition: all 0.2s ease; }
            .iob-btn:hover { background: #f8f9fa; border-color: #adb5bd; }
            .iob-btn.primary { background: #007bff; color: white; border-color: #007bff; }
            .iob-btn.primary:hover { background: #0056b3; border-color: #0056b3; }
            
            .iob-search-stats { font-size: 11px; color: #6c757d; margin-top: 4px; font-style: italic; }
            .iob-empty-state { padding: 40px 20px; text-align: center; color: #666; font-style: italic; background: #f8f9fa; border-radius: 4px; margin: 20px; }
            
            /* Wildcard specific styles */
            .wildcard-disabled {
                opacity: 0.6;
            }
            .wildcard-disabled label {
                color: #999 !important;
            }
            .wildcard-disabled input[type="checkbox"]:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
        `;
        document.head.appendChild(style);
    }
    
    class HierarchicalTreeData {
        constructor() {
            this.allNodes = new Map();
            this.rootNodes = [];
            this.filteredNodes = [];
            this.searchIndex = new Map();
            this.currentSearchTerm = '';
            this.isSearchMode = false;
            this.searchMatches = new Set();
            this.searchPaths = new Set();
        }
        
        async buildFromStates(states) {
            console.time('TreeData.buildFromStates');
            
            this.clear();
            const stateIds = Object.keys(states);
            
            for (let i = 0; i < stateIds.length; i += VIRTUAL_SCROLL_CONFIG.CHUNK_SIZE) {
                const chunk = stateIds.slice(i, i + VIRTUAL_SCROLL_CONFIG.CHUNK_SIZE);
                await this.processChunk(chunk);
                
                const progress = Math.round((i / stateIds.length) * 100);
                this.updateProgress?.(progress);
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
            
            this.buildNodeHierarchy();
            await this.buildSearchIndex();
            this.updateFilteredNodes();
            
            console.timeEnd('TreeData.buildFromStates');
            console.log(`Hierarchical tree built: ${this.allNodes.size} total nodes, search index: ${this.searchIndex.size} terms`);
        }
        
        async processChunk(stateIds) {
            stateIds.forEach(stateId => {
                const segments = stateId.split('.');
                let currentPath = '';
                
                for (let i = 0; i < segments.length; i++) {
                    const segment = segments[i];
                    const parentPath = currentPath;
                    currentPath = currentPath ? `${currentPath}.${segment}` : segment;
                    
                    if (!this.allNodes.has(currentPath)) {
                        const isLeaf = i === segments.length - 1;
                        const node = {
                            id: currentPath,
                            label: segment,
                            fullId: isLeaf ? stateId : null,
                            isLeaf: isLeaf,
                            depth: i,
                            parent: parentPath || null,
                            children: [],
                            expanded: false,
                            visible: true,
                            isMatch: false,
                            isPathToMatch: false
                        };
                        
                        this.allNodes.set(currentPath, node);
                    }
                }
            });
        }
        
        buildNodeHierarchy() {
            for (const [nodeId, node] of this.allNodes) {
                if (node.parent) {
                    const parentNode = this.allNodes.get(node.parent);
                    if (parentNode && !parentNode.children.includes(nodeId)) {
                        parentNode.children.push(nodeId);
                    }
                }
            }
            
            for (const [nodeId, node] of this.allNodes) {
                node.children.sort((a, b) => {
                    const nodeA = this.allNodes.get(a);
                    const nodeB = this.allNodes.get(b);
                    
                    if (nodeA.isLeaf !== nodeB.isLeaf) {
                        return nodeA.isLeaf ? 1 : -1;
                    }
                    return nodeA.label.localeCompare(nodeB.label, undefined, { numeric: true });
                });
            }
            
            this.rootNodes = Array.from(this.allNodes.values())
                .filter(node => !node.parent)
                .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
                .map(node => node.id);
        }
        
        async buildSearchIndex() {
            console.time('buildSearchIndex');
            
            this.searchIndex.clear();
            
            for (const [nodeId, node] of this.allNodes) {
                const searchTerms = new Set();
                
                const label = node.label.toLowerCase();
                searchTerms.add(label);
                
                const fullNodeId = nodeId.toLowerCase();
                searchTerms.add(fullNodeId);
                
                const segments = nodeId.split('.');
                segments.forEach(segment => {
                    searchTerms.add(segment.toLowerCase());
                });
                
                for (let i = 1; i <= segments.length; i++) {
                    const partialPath = segments.slice(0, i).join('.').toLowerCase();
                    searchTerms.add(partialPath);
                }
                
                if (node.fullId && node.fullId !== nodeId) {
                    searchTerms.add(node.fullId.toLowerCase());
                }
                
                searchTerms.forEach(term => {
                    if (!this.searchIndex.has(term)) {
                        this.searchIndex.set(term, new Set());
                    }
                    this.searchIndex.get(term).add(nodeId);
                });
            }
            
            console.timeEnd('buildSearchIndex');
            console.log(`Search index built: ${this.searchIndex.size} terms for ${this.allNodes.size} nodes`);
        }
        
        performSearch(searchTerm) {
            console.time('HierarchicalSearch');
            
            this.currentSearchTerm = searchTerm.trim();
            this.isSearchMode = this.currentSearchTerm.length > 0;
            
            for (const node of this.allNodes.values()) {
                node.visible = true;
                node.isMatch = false;
                node.isPathToMatch = false;
                
                if (!this.isSearchMode) {
                    node.expanded = false;
                }
            }
            
            this.searchMatches.clear();
            this.searchPaths.clear();
            
            if (!this.isSearchMode) {
                this.updateFilteredNodes();
                console.timeEnd('HierarchicalSearch');
                return { results: [], total: this.filteredNodes.length };
            }
            
            const directMatches = this.findMatchingNodes(this.currentSearchTerm);
            
            directMatches.forEach(nodeId => {
                const node = this.allNodes.get(nodeId);
                if (node) {
                    node.isMatch = true;
                    this.searchMatches.add(nodeId);
                }
            });
            
            directMatches.forEach(nodeId => {
                this.markAncestorPathsAsVisible(nodeId);
            });
            
            this.filterNodesForSearch();
            this.autoExpandPathsToMatches();
            this.updateFilteredNodes();
            
            console.timeEnd('HierarchicalSearch');
            console.log(`Hierarchical search "${this.currentSearchTerm}" completed: ${directMatches.length} direct matches, ${this.searchPaths.size} path nodes`);
            
            return {
                results: directMatches,
                total: this.filteredNodes.length,
                searchTerm: this.currentSearchTerm
            };
        }
        
        findMatchingNodes(searchTerm) {
            const results = new Set();
            const lowerTerm = searchTerm.toLowerCase().trim();
            
            if (this.searchIndex.has(lowerTerm)) {
                const directMatches = this.searchIndex.get(lowerTerm);
                directMatches.forEach(nodeId => results.add(nodeId));
            }
            
            for (const [indexedTerm, nodeIds] of this.searchIndex) {
                if (indexedTerm.includes(lowerTerm) && indexedTerm !== lowerTerm) {
                    nodeIds.forEach(nodeId => results.add(nodeId));
                }
            }
            
            const searchWords = searchTerm.trim().split(/\s+/).filter(word => word.length > 0);
            if (searchWords.length > 1) {
                for (const [nodeId, node] of this.allNodes) {
                    const nodeText = nodeId.toLowerCase();
                    const labelText = node.label.toLowerCase();
                    const fullText = `${nodeText} ${labelText}`;
                    
                    if (searchWords.every(word => fullText.includes(word.toLowerCase()))) {
                        results.add(nodeId);
                    }
                }
            }
            
            return Array.from(results);
        }
        
        markAncestorPathsAsVisible(nodeId) {
            let currentNode = this.allNodes.get(nodeId);
            
            while (currentNode) {
                if (!currentNode.isMatch) {
                    currentNode.isPathToMatch = true;
                    this.searchPaths.add(currentNode.id);
                }
                
                if (currentNode.parent) {
                    currentNode = this.allNodes.get(currentNode.parent);
                } else {
                    break;
                }
            }
        }
        
        filterNodesForSearch() {
            for (const node of this.allNodes.values()) {
                node.visible = node.isMatch || node.isPathToMatch || this.hasMatchingDescendants(node.id);
            }
        }
        
        hasMatchingDescendants(nodeId) {
            const node = this.allNodes.get(nodeId);
            if (!node || node.isLeaf) return false;
            
            for (const childId of node.children) {
                const childNode = this.allNodes.get(childId);
                if (childNode && (childNode.isMatch || this.hasMatchingDescendants(childId))) {
                    return true;
                }
            }
            
            return false;
        }
        
        autoExpandPathsToMatches() {
            for (const pathNodeId of this.searchPaths) {
                const node = this.allNodes.get(pathNodeId);
                if (node && !node.isLeaf) {
                    node.expanded = true;
                }
            }
        }
        
        updateFilteredNodes() {
            this.filteredNodes = [];
            
            this.rootNodes.forEach(rootId => {
                this.addNodeToFilteredList(rootId);
            });
        }
        
        addNodeToFilteredList(nodeId) {
            const node = this.allNodes.get(nodeId);
            if (!node || !node.visible) return;
            
            this.filteredNodes.push({
                ...node,
                index: this.filteredNodes.length,
                isSearchMatch: node.isMatch,
                isSearchPath: node.isPathToMatch
            });
            
            if (node.expanded && node.children.length > 0) {
                node.children.forEach(childId => {
                    this.addNodeToFilteredList(childId);
                });
            }
        }
        
        toggleNodeExpansion(nodeId) {
            const node = this.allNodes.get(nodeId);
            if (node && !node.isLeaf) {
                node.expanded = !node.expanded;
                this.updateFilteredNodes();
                return true;
            }
            return false;
        }
        
        getFilteredNodes() {
            return this.filteredNodes;
        }
        
        clear() {
            this.allNodes.clear();
            this.rootNodes = [];
            this.filteredNodes = [];
            this.searchIndex.clear();
            this.currentSearchTerm = '';
            this.isSearchMode = false;
            this.searchMatches.clear();
            this.searchPaths.clear();
        }
    }
    
    class HierarchicalTreeView {
        constructor(container, data) {
            this.container = container;
            this.data = data;
            this.selectedNodeId = null;
            
            this.setupDOM();
            this.setupEventListeners();
        }
        
        setupDOM() {
            this.container.innerHTML = '<div class="iob-tree-content"></div>';
            this.content = this.container.querySelector('.iob-tree-content');
        }
        
        setupEventListeners() {
            this.content.addEventListener('click', (e) => {
                const item = e.target.closest('.iob-tree-item');
                if (item) this.handleItemClick(item);
            });
            
            this.content.addEventListener('dblclick', (e) => {
                const item = e.target.closest('.iob-tree-item');
                if (item) this.handleItemDoubleClick(item);
            });
        }
        
        render() {
            const nodes = this.data.getFilteredNodes();
            
            if (nodes.length === 0) {
                this.renderEmptyState();
                return;
            }
            
            const fragment = document.createDocumentFragment();
            
            nodes.forEach(node => {
                const element = this.createNodeElement(node);
                fragment.appendChild(element);
            });
            
            this.content.innerHTML = '';
            this.content.appendChild(fragment);
        }
        
        renderEmptyState() {
            const message = this.data.isSearchMode 
                ? `No items found containing "${this.data.currentSearchTerm}"`
                : 'No items to display';
                
            this.content.innerHTML = `<div class="iob-empty-state">${message}</div>`;
        }
        
        createNodeElement(node) {
            const element = document.createElement('div');
            element.className = `iob-tree-item ${node.isLeaf ? 'leaf' : 'folder'}`;
            element.dataset.nodeId = node.id;
            element.style.paddingLeft = `${(node.depth * 16) + 8}px`;
            
            if (node.isSearchMatch) {
                element.classList.add('search-match');
            } else if (node.isSearchPath) {
                element.classList.add('search-path');
            }
            
            if (node.id === this.selectedNodeId) {
                element.classList.add('selected');
            }
            
            const icon = node.isLeaf ? '🔗' : (node.expanded ? '📂' : '📁');
            const label = this.highlightSearchTerm(node.label);
            
            element.innerHTML = `
                <span class="iob-tree-icon">${icon}</span>
                <span class="iob-tree-label" title="${node.id}">${label}</span>
            `;
            
            return element;
        }
        
        highlightSearchTerm(text) {
            if (!this.data.isSearchMode || !this.data.currentSearchTerm) {
                return text;
            }
            
            const searchTerm = this.data.currentSearchTerm.trim();
            const searchWords = searchTerm.split(/\s+/).filter(word => word.length > 0);
            let result = text;
            
            searchWords.forEach(word => {
                const regex = new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
                result = result.replace(regex, '<mark>$1</mark>');
            });
            
            if (searchWords.length > 1) {
                const completeTermRegex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
                result = result.replace(completeTermRegex, '<mark>$1</mark>');
            }
            
            return result;
        }
        
        handleItemClick(element) {
            const nodeId = element.dataset.nodeId;
            
            this.container.querySelectorAll('.iob-tree-item.selected').forEach(el => {
                el.classList.remove('selected');
            });
            element.classList.add('selected');
            this.selectedNodeId = nodeId;
            
            if (this.data.toggleNodeExpansion(nodeId)) {
                this.render();
            }
        }
        
        handleItemDoubleClick(element) {
            const nodeId = element.dataset.nodeId;
            const node = this.data.allNodes.get(nodeId);
            
            if (node && node.isLeaf && node.fullId) {
                this.onItemSelected?.(node.fullId);
            } else if (node && !node.isLeaf) {
                this.onItemSelected?.(node.id);
            }
        }
        
        updateSearch(searchTerm) {
            const searchResults = this.data.performSearch(searchTerm);
            this.render();
            return searchResults;
        }
        
        destroy() {
            this.container.innerHTML = '';
        }
    }
    
    // Utility functions
    function getCacheKey(serverHost, serverPort) {
        return `${serverHost}:${serverPort}`;
    }
    
    function isCacheValid(cacheEntry) {
        if (!cacheEntry) return false;
        return (Date.now() - cacheEntry.timestamp) < VIRTUAL_SCROLL_CONFIG.CACHE_DURATION;
    }
    
    function getCachedStates(serverId) {
        const cacheEntry = stateCache.get(serverId);
        if (isCacheValid(cacheEntry)) {
            performanceMetrics.cacheHits++;
            return cacheEntry.data;
        }
        performanceMetrics.cacheMisses++;
        return null;
    }
    
    function setCachedStates(serverId, data) {
        stateCache.set(serverId, {
            data: data,
            timestamp: Date.now()
        });
    }
    
    // Wildcard detection and validation utilities
    function detectWildcardPattern(pattern) {
        const hasWildcardChars = pattern.includes('*');
        const hasUnsupportedChars = pattern.includes('?');
        
        return {
            isWildcard: hasWildcardChars,
            hasUnsupported: hasUnsupportedChars,
            warnings: validateWildcardPattern(pattern)
        };
    }
    
    function validateWildcardPattern(pattern) {
        if (!pattern) return [];
        
        const issues = [];
        
        if (pattern.includes('?')) {
            issues.push('ioBroker only supports * wildcards, not ? wildcards');
        }
        
        if (pattern.includes('**')) {
            issues.push('Avoid consecutive wildcards (**)');
        }
        
        if (pattern.startsWith('*')) {
            issues.push('Patterns starting with * may match too many states');
        }
        
        if (pattern.split('*').length > 4) {
            issues.push('Too many wildcards may impact performance');
        }
        
        if (pattern === '*' || pattern === '*.*') {
            issues.push('This pattern will match ALL states - use with caution!');
        }
        
        return issues;
    }
    
    // Main TreeView Factory
    function createTreeView(config) {
        const {
            nodeType,
            inputId, 
            serverInputId,
            searchPlaceholder = "Search items (hierarchical filtering)...",
            itemType = "items",
            dataEndpoint = "/iobroker/ws/states",
            enableWildcardDetection = false,
            wildcardInputId = null
        } = config;
        
        // Inject styles
        injectStyles();
        
        const stateInput = $('#' + inputId);
        const serverInput = $('#' + serverInputId);
        
        const treeContainer = $('<div class="iob-virtual-container"></div>');
        const searchContainer = $(`
            <div class="iob-search-container" style="display:none;">
                <input type="text" class="iob-search-input" placeholder="${searchPlaceholder}">
            </div>
        `);
        const controlButtons = $(`
            <div class="iob-control-buttons">
                <button type="button" class="iob-btn primary">Switch to tree selection</button>
                <button type="button" class="iob-btn" title="Refresh ${itemType}">
                    <i class="fa fa-refresh"></i> Refresh
                </button>
                <button type="button" class="iob-btn" title="Clear search">
                    <i class="fa fa-times"></i> Clear
                </button>
            </div>
        `);
        const statusElement = $('<div class="iob-status"></div>');
        const searchStatsElement = $('<div class="iob-search-stats"></div>');
        
        stateInput.after(searchStatsElement).after(statusElement).after(treeContainer).after(searchContainer).after(controlButtons);
        
        const toggleButton = controlButtons.find('.iob-btn.primary');
        const refreshButton = controlButtons.find('.iob-btn:not(.primary)').first();
        const clearButton = controlButtons.find('.iob-btn:not(.primary)').last();
        const searchInput = searchContainer.find('.iob-search-input');
        
        const treeData = new HierarchicalTreeData();
        let treeView = null;
        let currentServerId = null;
        let dataLoaded = false;
        let searchTimeout = null;
        
        treeData.updateProgress = (progress) => {
            if (progress >= 100) {
                showStatus('success', `Hierarchical ${itemType} tree processing complete`);
            }
        };
        
        // Wildcard detection for iobin nodes
        if (enableWildcardDetection && wildcardInputId) {
            stateInput.on('input keyup change', function() {
                const pattern = $(this).val();
                const wildcardInfo = detectWildcardPattern(pattern);
                
                if (wildcardInfo.isWildcard) {
                    showWildcardInfo(wildcardInfo.warnings);
                    
                    // Disable initial value option for wildcards
                    const initialValueCheckbox = $('#' + wildcardInputId);
                    if (initialValueCheckbox.length) {
                        initialValueCheckbox.prop('checked', false).prop('disabled', true);
                        initialValueCheckbox.closest('.form-row').addClass('wildcard-disabled');
                    }
                } else {
                    hideWildcardInfo();
                    
                    // Re-enable initial value option
                    const initialValueCheckbox = $('#' + wildcardInputId);
                    if (initialValueCheckbox.length) {
                        initialValueCheckbox.prop('disabled', false);
                        initialValueCheckbox.closest('.form-row').removeClass('wildcard-disabled');
                    }
                }
            });
        }
        
        function showWildcardInfo(warnings) {
            let existingInfo = $('#wildcard-info');
            if (existingInfo.length === 0) {
                existingInfo = $('<div id="wildcard-info"></div>');
                stateInput.after(existingInfo);
            }
            
            let warningText = '';
            if (warnings.length > 0) {
                warningText = `
                    <div style="color: #f39c12; font-size: 12px; margin-top: 5px;">
                        <i class="fa fa-exclamation-triangle"></i> 
                        ${warnings.join('; ')}
                    </div>
                `;
            }
            
            existingInfo.html(`
                <div style="background-color: #e8f4fd; border: 1px solid #bee5eb; border-radius: 4px; padding: 10px; font-size: 13px; color: #0c5460; margin-top: 5px;">
                    <i class="fa fa-info-circle" style="color: #17a2b8; margin-right: 5px;"></i>
                    <strong>Wildcard Mode (Auto-detected):</strong><br>
                    <ul style="margin: 8px 0 0 20px; padding: 0;">
                        <li><code>*</code> matches any number of characters</li>
                        <li><code>?</code> is <strong>not supported</strong> by ioBroker</li>
                        <li>Example: <code>system.adapter.*.alive</code></li>
                    </ul>
                    ${warningText}
                </div>
            `).show();
        }
        
        function hideWildcardInfo() {
            $('#wildcard-info').hide();
        }
        
        async function loadTree(forceRefresh = false) {
            console.time(`Hierarchical ${itemType} Tree Loading`);
            
            const serverNode = RED.nodes.node(serverInput.val());
            if (!serverNode) {
                showError('No server selected');
                return;
            }
            
            const serverId = getCacheKey(serverNode.iobhost, serverNode.iobport);
            currentServerId = serverId;
            
            if (!forceRefresh) {
                const cachedData = getCachedStates(serverId);
                if (cachedData) {
                    await renderTree(cachedData, true);
                    console.timeEnd(`Hierarchical ${itemType} Tree Loading`);
                    return;
                }
            }
            
            try {
                showStatus('info', `Loading ${itemType} from ioBroker...`);
                treeContainer.html(`<div style="padding: 20px; text-align: center;"><i class="fa fa-spinner fa-spin"></i> Loading hierarchical ${itemType} tree...</div>`);
                
                const response = await $.ajax({
                    url: `${dataEndpoint}/${encodeURIComponent(serverId)}`,
                    method: 'GET',
                    timeout: 20000,
                    dataType: 'json'
                });
                
                const dataCount = Object.keys(response).length;
                if (dataCount === 0) throw new Error(`No ${itemType} received`);
                
                setCachedStates(serverId, response);
                await renderTree(response, false);
                
            } catch (error) {
                console.error(`Hierarchical ${itemType} tree loading failed:`, error);
                showError(`Error: ${error.message || 'Unknown error'}`);
            } finally {
                console.timeEnd(`Hierarchical ${itemType} Tree Loading`);
            }
        }
        
        async function renderTree(data, fromCache) {
            console.time(`Hierarchical ${itemType} Tree Rendering`);
            
            await treeData.buildFromStates(data);
            
            if (treeView) {
                treeView.destroy();
            }
            
            treeView = new HierarchicalTreeView(treeContainer[0], treeData);
            treeView.onItemSelected = (itemId) => {
                stateInput.val(itemId).trigger('change');
                RED.notify(`Selected: ${itemId}`, { type: "success", timeout: 2000 });
                setTimeout(() => toggleInputMode(), 300);
            };
            
            treeView.render();
            
            dataLoaded = true;
            const dataCount = Object.keys(data).length;
            const cacheStatus = fromCache ? '(cached)' : '(fresh)';
            
            showStatus('success', `Loaded ${dataCount} ${itemType} ${cacheStatus} - Hierarchical search ready`);
            
            console.timeEnd(`Hierarchical ${itemType} Tree Rendering`);
        }
        
        searchInput.on('input', function() {
            clearTimeout(searchTimeout);
            const searchTerm = $(this).val().trim();
            
            searchTimeout = setTimeout(() => {
                if (treeView && treeData) {
                    const searchStats = treeView.updateSearch(searchTerm);
                    
                    if (searchTerm) {
                        const resultText = searchStats.results.length === 1 ? itemType.slice(0, -1) : itemType;
                        searchStatsElement.html(
                            `Found ${searchStats.results.length} matching ${resultText} for "${searchStats.searchTerm}"`
                        ).show();
                    } else {
                        searchStatsElement.html(`Showing complete ${itemType} tree structure`).show();
                        setTimeout(() => searchStatsElement.hide(), 2000);
                    }
                }
            }, 200);
        });
        
        function toggleInputMode() {
            const isManualVisible = stateInput.is(':visible');
            stateInput.toggle(!isManualVisible);
            treeContainer.toggle(isManualVisible);
            searchContainer.toggle(isManualVisible);
            
            if (!isManualVisible) {
                statusElement.hide();
                searchStatsElement.hide();
            }
            
            toggleButton.text(isManualVisible ? 'Switch to manual input' : 'Switch to hierarchical tree');
            
            if (isManualVisible && !dataLoaded) {
                loadTree();
            }
        }
        
        function showStatus(type, message) {
            const iconMap = {
                success: 'fa-check-circle',
                info: 'fa-info-circle',
                error: 'fa-exclamation-triangle'
            };
            
            statusElement.html(`
                <span class="iob-status iob-status-${type}">
                    <i class="fa ${iconMap[type]}"></i> ${message}
                </span>
            `).show();
        }
        
        function showError(message) {
            showStatus('error', message);
            treeContainer.html(`
                <div style="padding: 20px; text-align: center; color: #dc3545;">
                    <i class="fa fa-exclamation-triangle"></i> ${message}
                    <br><small>Check server connection and try refreshing</small>
                </div>
            `);
        }
        
        toggleButton.on('click', toggleInputMode);
        
        refreshButton.on('click', function() {
            if (currentServerId) {
                stateCache.delete(currentServerId);
                const icon = $(this).find('i');
                icon.addClass('fa-spin');
                
                loadTree(true).finally(() => {
                    setTimeout(() => icon.removeClass('fa-spin'), 500);
                });
                
                RED.notify(`Refreshing hierarchical ${itemType} tree...`, { type: "info", timeout: 2000 });
            }
        });
        
        clearButton.on('click', function() {
            searchInput.val('').trigger('input');
            searchInput.focus();
        });
        
        serverInput.on('change', function() {
            treeData.clear();
            if (treeView) {
                treeView.destroy();
                treeView = null;
            }
            dataLoaded = false;
            statusElement.html('');
            searchStatsElement.hide();
            
            if (treeContainer.is(':visible')) {
                loadTree();
            }
        });
        
        return {
            cleanup: function() {
                if (treeView) treeView.destroy();
                clearTimeout(searchTimeout);
                controlButtons.remove();
                searchContainer.remove();
                treeContainer.remove();
                statusElement.remove();
                searchStatsElement.remove();
                stateInput.show();
                $('#wildcard-info').remove();
            }
        };
    }
    
    // Expose the main API
    global.ioBrokerSharedTreeView = {
        version: '1.0.0',
        setup: createTreeView,
        
        // Legacy compatibility
        HierarchicalTreeData,
        HierarchicalTreeView,
        
        // Utilities
        getCacheKey,
        getCachedStates,
        setCachedStates,
        detectWildcardPattern,
        validateWildcardPattern,
        performanceMetrics
    };
    
    // Legacy name for backwards compatibility
    global.ioBrokerOptimizedTreeView = global.ioBrokerSharedTreeView;
    
    // Mark as initialized
    global.ioBrokerSharedTreeView.initialized = true;
    
    console.log('ioBroker Shared TreeView v1.0.0 loaded successfully');
    
})(window);