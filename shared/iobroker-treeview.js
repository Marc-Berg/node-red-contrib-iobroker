(function(global) {
    'use strict';
    
    if (typeof global.ioBrokerSharedTreeView !== 'undefined' && global.ioBrokerSharedTreeView.initialized) {
        return;
    }
    
    const VIRTUAL_SCROLL_CONFIG = {
        ITEM_HEIGHT: 24,
        BUFFER_SIZE: 5,
        CHUNK_SIZE: 100,
        CACHE_DURATION: 5 * 60 * 1000
    };
    
    const stateCache = new Map();
    
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
            .iob-tree-item.selected.folder { background-color: #fff3cd; border-left: 3px solid #ffc107; }
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
            
            .iob-selected-state-info {
                display: inline-block;
                margin-left: 8px;
                padding: 2px 8px;
                background-color: #d1ecf1;
                border: 1px solid #bee5eb;
                border-radius: 3px;
                font-size: 12px;
                color: #0c5460;
                font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
                font-weight: normal;
                max-width: 300px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                vertical-align: middle;
                line-height: 1.2;
            }
            
            .iob-selected-state-info.folder {
                background-color: #fff3cd;
                border-color: #ffeaa7;
                color: #856404;
            }
            
            .iob-state-label-container {
                display: inline-block;
                vertical-align: middle;
                white-space: nowrap;
            }
            
            .iob-tree-actions {
                display: flex;
                gap: 8px;
                margin-top: 8px;
                padding-top: 8px;
                border-top: 1px solid #dee2e6;
                justify-content: flex-end;
            }
            
            .iob-status { padding: 6px 10px; border-radius: 3px; font-size: 12px; font-weight: 500; margin-top: 5px; display: inline-block; }
            .iob-status-success { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
            .iob-status-info { background-color: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
            .iob-status-error { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
            
            .iob-control-buttons { display: flex; gap: 8px; margin-top: 5px; }
            .iob-btn { padding: 6px 12px; border: 1px solid #ddd; border-radius: 4px; background: white; cursor: pointer; font-size: 12px; transition: all 0.2s ease; }
            .iob-btn:hover { background: #f8f9fa; border-color: #adb5bd; }
            .iob-btn.primary { background: #007bff; color: white; border-color: #007bff; }
            .iob-btn.primary:hover { background: #0056b3; border-color: #0056b3; }
            .iob-btn.success { background: #28a745; color: white; border-color: #28a745; }
            .iob-btn.success:hover { background: #1e7e34; border-color: #1e7e34; }
            .iob-btn.success:disabled { background: #6c757d; border-color: #6c757d; cursor: not-allowed; opacity: 0.6; }
            .iob-btn.refreshing { background: #28a745; color: white; border-color: #28a745; }
            
            .iob-search-stats { font-size: 11px; color: #6c757d; margin-top: 4px; font-style: italic; }
            .iob-empty-state { padding: 40px 20px; text-align: center; color: #666; font-style: italic; background: #f8f9fa; border-radius: 4px; margin: 20px; }
            
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
            this.clear();
            const stateIds = Object.keys(states);
            
            for (let i = 0; i < stateIds.length; i += VIRTUAL_SCROLL_CONFIG.CHUNK_SIZE) {
                const chunk = stateIds.slice(i, i + VIRTUAL_SCROLL_CONFIG.CHUNK_SIZE);
                await this.processChunk(chunk);
                
                if (i % (VIRTUAL_SCROLL_CONFIG.CHUNK_SIZE * 5) === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
            
            this.buildNodeHierarchy();
            await this.buildSearchIndex();
            this.updateFilteredNodes();
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
            this.searchIndex.clear();
            
            for (const [nodeId, node] of this.allNodes) {
                const searchTerms = new Set();
                
                searchTerms.add(node.label.toLowerCase());
                searchTerms.add(nodeId.toLowerCase());
                
                const segments = nodeId.split('.');
                segments.forEach(segment => {
                    searchTerms.add(segment.toLowerCase());
                });
                
                for (let i = 1; i <= segments.length; i++) {
                    const partialPath = segments.slice(0, i).join('.').toLowerCase();
                    searchTerms.add(partialPath);
                }
                
                searchTerms.forEach(term => {
                    if (!this.searchIndex.has(term)) {
                        this.searchIndex.set(term, new Set());
                    }
                    this.searchIndex.get(term).add(nodeId);
                });
            }
        }
        
        performSearch(searchTerm) {
            this.currentSearchTerm = searchTerm.trim();
            this.isSearchMode = this.currentSearchTerm.length > 0;
            
            for (const node of this.allNodes.values()) {
                node.visible = true;
                node.isMatch = false;
                node.isPathToMatch = false;
                node.expanded = this.isSearchMode ? false : node.expanded;
            }
            
            this.searchMatches.clear();
            this.searchPaths.clear();
            
            if (!this.isSearchMode) {
                this.updateFilteredNodes();
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
                this.searchIndex.get(lowerTerm).forEach(nodeId => results.add(nodeId));
            }
            
            for (const [indexedTerm, nodeIds] of this.searchIndex) {
                if (indexedTerm.includes(lowerTerm)) {
                    nodeIds.forEach(nodeId => results.add(nodeId));
                }
            }
            
            return Array.from(results);
        }
        
        markAncestorPathsAsVisible(nodeId) {
            let currentNode = this.allNodes.get(nodeId);
            
            while (currentNode && currentNode.parent) {
                const parentNode = this.allNodes.get(currentNode.parent);
                if (parentNode && !parentNode.isMatch) {
                    parentNode.isPathToMatch = true;
                    this.searchPaths.add(parentNode.id);
                }
                currentNode = parentNode;
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
        
        collapseAllNodes() {
            for (const node of this.allNodes.values()) {
                if (!node.isLeaf) {
                    node.expanded = false;
                }
            }
            this.updateFilteredNodes();
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
            this.onItemSelected = null;
            this.onSelectionChanged = null;
            
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
                ? `No items found for "${this.data.currentSearchTerm}"`
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
            const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            return text.replace(regex, '<mark>$1</mark>');
        }
        
        handleItemClick(element) {
            const nodeId = element.dataset.nodeId;
            
            // Update visual selection
            this.container.querySelectorAll('.iob-tree-item.selected').forEach(el => {
                el.classList.remove('selected');
            });
            element.classList.add('selected');
            this.selectedNodeId = nodeId;
            
            // Notify selection change
            if (this.onSelectionChanged) {
                const node = this.data.allNodes.get(nodeId);
                this.onSelectionChanged(node);
            }
            
            // Handle expansion/collapse for folders
            if (this.data.toggleNodeExpansion(nodeId)) {
                this.render();
            }
        }
        
        handleItemDoubleClick(element) {
            const nodeId = element.dataset.nodeId;
            const node = this.data.allNodes.get(nodeId);
            
            if (node) {
                if (node.isLeaf && this.onItemSelected) {
                    // Only allow double-click selection for leaf nodes (states)
                    const itemId = node.fullId || node.id;
                    this.onItemSelected(itemId);
                } else if (!node.isLeaf) {
                    // For folders, just toggle expansion on double-click
                    this.data.toggleNodeExpansion(nodeId);
                    this.render();
                }
            }
        }
        
        updateSearch(searchTerm) {
            const searchResults = this.data.performSearch(searchTerm);
            this.render();
            return searchResults;
        }
        
        getSelectedNode() {
            return this.selectedNodeId ? this.data.allNodes.get(this.selectedNodeId) : null;
        }
        
        setSelectedNode(nodeId) {
            this.selectedNodeId = nodeId;
            const node = this.data.allNodes.get(nodeId);
            if (node && this.onSelectionChanged) {
                this.onSelectionChanged(node);
            }
        }
        
        destroy() {
            if (this.container) {
                this.container.innerHTML = '';
            }
        }
    }
    
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
            return cacheEntry.data;
        }
        return null;
    }
    
    function setCachedStates(serverId, data) {
        stateCache.set(serverId, {
            data: data,
            timestamp: Date.now()
        });
    }
    
    function clearCache(serverId = null) {
        if (serverId) {
            stateCache.delete(serverId);
            console.log(`[TreeView] Cache cleared for ${serverId}`);
        } else {
            stateCache.clear();
            console.log(`[TreeView] All caches cleared`);
        }
    }
    
    function forceRefreshCache() {
        const currentTime = Date.now();
        const cacheBreaker = `cb=${currentTime}`;
        console.log(`[TreeView] Force refresh with cache breaker: ${cacheBreaker}`);
        return cacheBreaker;
    }
    
    function detectWildcardPattern(pattern) {
        if (!pattern) return { isWildcard: false, hasUnsupported: false, warnings: [] };
        
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
        
        if (pattern === '*' || pattern === '*.*') {
            issues.push('This pattern will match ALL states - use with caution!');
        }
        
        const wildcardCount = (pattern.match(/\*/g) || []).length;
        if (wildcardCount > 3) {
            issues.push('Too many wildcards may impact performance');
        }
        
        return issues;
    }
    
    function createTreeView(config) {
        try {
            const {
                nodeType,
                inputId, 
                serverInputId,
                searchPlaceholder = "Search items...",
                itemType = "items",
                dataEndpoint = "/iobroker/ws/states",
                enableWildcardDetection = false,
                wildcardInputId = null
            } = config;
            
            injectStyles();
            
            const stateInput = $('#' + inputId);
            const serverInput = $('#' + serverInputId);
            
            if (!stateInput.length || !serverInput.length) {
                throw new Error('Required input elements not found');
            }
            
            const treeContainer = $('<div class="iob-virtual-container"></div>');
            const searchContainer = $(`
                <div class="iob-search-container" style="display:none;">
                    <input type="text" class="iob-search-input" placeholder="${searchPlaceholder}">
                </div>
            `);
            
            // Action buttons for tree view
            const treeActions = $(`
                <div class="iob-tree-actions" style="display:none;">
                    <button type="button" class="iob-btn success" disabled>
                        <i class="fa fa-check"></i> Use State
                    </button>
                    <button type="button" class="iob-btn">
                        <i class="fa fa-times"></i> Cancel
                    </button>
                </div>
            `);
            
            const controlButtons = $(`
                <div class="iob-control-buttons">
                    <button type="button" class="iob-btn primary">Switch to tree selection</button>
                    <button type="button" class="iob-btn" title="Refresh ${itemType} (bypasses all caches)">
                        <i class="fa fa-refresh"></i> Refresh
                    </button>
                    <button type="button" class="iob-btn" title="Clear search">
                        <i class="fa fa-times"></i> Clear
                    </button>
                </div>
            `);
            const statusElement = $('<div class="iob-status"></div>');
            const searchStatsElement = $('<div class="iob-search-stats"></div>');
            
            stateInput.after(searchStatsElement)
                      .after(statusElement)
                      .after(treeActions)
                      .after(treeContainer)
                      .after(searchContainer)
                      .after(controlButtons);
            
            const toggleButton = controlButtons.find('.iob-btn.primary');
            const refreshButton = controlButtons.find('.iob-btn:not(.primary)').first();
            const clearButton = controlButtons.find('.iob-btn:not(.primary)').last();
            const searchInput = searchContainer.find('.iob-search-input');
            const useSelectedButton = treeActions.find('.iob-btn.success');
            const cancelButton = treeActions.find('.iob-btn:not(.success)');
            
            // Get the label element for the state input
            const stateInputLabel = $(`label[for="${inputId}"]`);
            let originalLabelText = stateInputLabel.text();
            
            const treeData = new HierarchicalTreeData();
            let treeView = null;
            let currentServerId = null;
            let dataLoaded = false;
            let searchTimeout = null;
            let selectedStateId = null;
            
            if (enableWildcardDetection && wildcardInputId) {
                stateInput.on('input keyup change', function() {
                    const pattern = $(this).val();
                    const wildcardInfo = detectWildcardPattern(pattern);
                    
                    if (wildcardInfo.isWildcard) {
                        showWildcardInfo(wildcardInfo.warnings);
                        
                        const initialValueCheckbox = $('#' + wildcardInputId);
                        if (initialValueCheckbox.length) {
                            initialValueCheckbox.prop('checked', false).prop('disabled', true);
                            initialValueCheckbox.closest('.form-row').addClass('wildcard-disabled');
                        }
                    } else {
                        hideWildcardInfo();
                        
                        const initialValueCheckbox = $('#' + wildcardInputId);
                        if (initialValueCheckbox.length) {
                            initialValueCheckbox.prop('disabled', false);
                            initialValueCheckbox.closest('.form-row').removeClass('wildcard-disabled');
                        }
                    }
                });
            }
            
            function showWildcardInfo(warnings) {
                let existingInfo = $('#wildcard-info-' + nodeType);
                if (existingInfo.length === 0) {
                    existingInfo = $(`<div id="wildcard-info-${nodeType}"></div>`);
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
                $('#wildcard-info-' + nodeType).hide();
            }
            
            function updateCurrentSelection(node) {
                if (node && node.isLeaf) {
                    selectedStateId = node.fullId || node.id;
                    updateStateLabel(selectedStateId, false);
                    useSelectedButton.prop('disabled', false);
                } else if (node && !node.isLeaf) {
                    selectedStateId = node.id;
                    updateStateLabel(selectedStateId + ' (folder - not selectable)', true);
                    useSelectedButton.prop('disabled', true); // Folders cannot be used
                } else {
                    selectedStateId = null;
                    updateStateLabel(null, false);
                    useSelectedButton.prop('disabled', true);
                }
            }
            
            function updateStateLabel(selectedValue, isFolder = false) {
                if (selectedValue && stateInputLabel.length) {
                    // Remove any existing selection info
                    stateInputLabel.find('.iob-selected-state-info').remove();
                    
                    // Create container if it doesn't exist
                    if (!stateInputLabel.hasClass('iob-state-label-container')) {
                        stateInputLabel.addClass('iob-state-label-container');
                    }
                    
                    // Add new selection info as inline element with appropriate class
                    const folderClass = isFolder ? ' folder' : '';
                    const selectionInfo = $(`<span class="iob-selected-state-info${folderClass}" title="${selectedValue}">${selectedValue}</span>`);
                    stateInputLabel.append(selectionInfo);
                } else if (stateInputLabel.length) {
                    // Remove selection info
                    stateInputLabel.find('.iob-selected-state-info').remove();
                    stateInputLabel.removeClass('iob-state-label-container');
                }
            }
            
            function findAndSelectExistingState(stateId) {
                if (!stateId || !treeData) return false;
                
                // Check if the exact state exists
                const exactNode = treeData.allNodes.get(stateId);
                if (exactNode) {
                    // Expand path to this node
                    expandPathToNode(stateId);
                    
                    // Set as selected
                    if (treeView) {
                        treeView.setSelectedNode(stateId);
                    }
                    
                    console.log(`[TreeView] Found and selected existing ${exactNode.isLeaf ? 'state' : 'folder'}: ${stateId}`);
                    return true;
                }
                
                // If exact match not found, try to find the closest parent
                const segments = stateId.split('.');
                for (let i = segments.length - 1; i > 0; i--) {
                    const partialPath = segments.slice(0, i).join('.');
                    const partialNode = treeData.allNodes.get(partialPath);
                    if (partialNode) {
                        // Expand path to the closest parent
                        expandPathToNode(partialPath);
                        
                        // Set partial path as selected to show user where we are
                        if (treeView) {
                            treeView.setSelectedNode(partialPath);
                        }
                        
                        console.log(`[TreeView] State not found, selected closest parent: ${partialPath}`);
                        return true;
                    }
                }
                
                console.log(`[TreeView] State not found in tree: ${stateId}`);
                return false;
            }
            
            function expandPathToNode(nodeId) {
                if (!nodeId || !treeData) return;
                
                let currentNodeId = nodeId;
                const pathToExpand = [];
                
                // Collect all parent nodes that need to be expanded
                while (currentNodeId) {
                    const node = treeData.allNodes.get(currentNodeId);
                    if (!node) break;
                    
                    if (node.parent) {
                        pathToExpand.unshift(node.parent);
                    }
                    currentNodeId = node.parent;
                }
                
                // Expand all parent nodes
                pathToExpand.forEach(parentId => {
                    const parentNode = treeData.allNodes.get(parentId);
                    if (parentNode && !parentNode.isLeaf) {
                        parentNode.expanded = true;
                    }
                });
                
                // Update filtered nodes to reflect expansions
                treeData.updateFilteredNodes();
                
                console.log(`[TreeView] Expanded path to: ${nodeId} (${pathToExpand.length} parents)`);
            }
            
            async function loadTree(forceRefresh = false) {
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
                        return;
                    }
                }
                
                // Clear cache on force refresh
                if (forceRefresh) {
                    clearCache(serverId);
                }

                try {
                    showStatus('info', `Loading ${itemType} from ioBroker...`);
                    treeContainer.html(`<div style="padding: 20px; text-align: center;"><i class="fa fa-spinner fa-spin"></i> Loading ${itemType}...</div>`);
                    
                    // Build URL with cache busting for force refresh
                    let url = `${dataEndpoint}/${encodeURIComponent(serverId)}`;
                    if (forceRefresh) {
                        const cacheBreaker = forceRefreshCache();
                        url += `?${cacheBreaker}`;
                    }
                    
                    const response = await $.ajax({
                        url: url,
                        method: 'GET',
                        timeout: 20000,
                        dataType: 'json',
                        cache: false, // Disable jQuery caching
                        headers: {
                            'Cache-Control': 'no-cache, no-store, must-revalidate',
                            'Pragma': 'no-cache',
                            'Expires': '0'
                        }
                    });
                    
                    const dataCount = Object.keys(response).length;
                    if (dataCount === 0) throw new Error(`No ${itemType} received`);
                    
                    setCachedStates(serverId, response);
                    await renderTree(response, false);
                    
                } catch (error) {
                    showError(`Error: ${error.message || 'Unknown error'}`);
                }
            }
            
            async function renderTree(data, fromCache) {
                await treeData.buildFromStates(data);
                
                if (treeView) {
                    treeView.destroy();
                }
                
                treeView = new HierarchicalTreeView(treeContainer[0], treeData);
                
                // Handle selection changes (single click)
                treeView.onSelectionChanged = (node) => {
                    updateCurrentSelection(node);
                };
                
                // Handle double click (immediate selection)
                treeView.onItemSelected = (itemId) => {
                    stateInput.val(itemId).trigger('change');
                    if (typeof RED !== 'undefined' && RED.notify) {
                        RED.notify(`Selected: ${itemId}`, { type: "success", timeout: 2000 });
                    }
                    setTimeout(() => toggleInputMode(), 300);
                };
                
                // Find and select existing state from input field
                const existingStateId = stateInput.val().trim();
                if (existingStateId) {
                    findAndSelectExistingState(existingStateId);
                }
                
                treeView.render();
                
                dataLoaded = true;
                const dataCount = Object.keys(data).length;
                const cacheStatus = fromCache ? '(cached)' : '(fresh)';
                
                showStatus('success', `Loaded ${dataCount} ${itemType} ${cacheStatus}`);
            }
            
            searchInput.on('input', function() {
                clearTimeout(searchTimeout);
                const searchTerm = $(this).val().trim();
                
                searchTimeout = setTimeout(() => {
                    if (treeView && treeData) {
                        const searchStats = treeView.updateSearch(searchTerm);
                        
                        if (searchTerm) {
                            searchStatsElement.html(
                                `Found ${searchStats.results.length} matching ${itemType} for "${searchStats.searchTerm}"`
                            ).show();
                        } else {
                            searchStatsElement.html(`Showing all ${itemType}`).show();
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
                treeActions.toggle(isManualVisible);
                
                if (!isManualVisible) {
                    statusElement.hide();
                    searchStatsElement.hide();
                    updateCurrentSelection(null); // Clear selection and label
                } else {
                    // When switching to tree view, try to find and select existing state
                    const existingStateId = stateInput.val().trim();
                    if (existingStateId && dataLoaded && treeData) {
                        setTimeout(() => {
                            findAndSelectExistingState(existingStateId);
                            if (treeView) {
                                treeView.render(); // Re-render to show selection
                            }
                        }, 100);
                    }
                }
                
                toggleButton.text(isManualVisible ? 'Switch to manual input' : 'Switch to tree view');
                
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
            
            // Event handlers
            toggleButton.on('click', toggleInputMode);
            
            useSelectedButton.on('click', function() {
                if (selectedStateId && treeView) {
                    const selectedNode = treeView.getSelectedNode();
                    // Only allow using leaf nodes (states), not folders
                    if (selectedNode && selectedNode.isLeaf) {
                        const stateToUse = selectedNode.fullId || selectedNode.id;
                        stateInput.val(stateToUse).trigger('change');
                        if (typeof RED !== 'undefined' && RED.notify) {
                            RED.notify(`Selected: ${stateToUse}`, { type: "success", timeout: 2000 });
                        }
                        toggleInputMode();
                    } else {
                        if (typeof RED !== 'undefined' && RED.notify) {
                            RED.notify('Folders cannot be selected as states', { type: "warning", timeout: 2000 });
                        }
                    }
                }
            });
            
            cancelButton.on('click', function() {
                toggleInputMode();
            });
            
            refreshButton.on('click', function() {
                if (currentServerId) {
                    // Clear search field
                    searchInput.val('').trigger('input');
                    searchStatsElement.hide();
                    updateCurrentSelection(null);
                    
                    // Force clear local cache
                    clearCache(currentServerId);
                    
                    const icon = $(this).find('i');
                    const buttonText = $(this);
                    const originalText = buttonText.text();
                    
                    icon.addClass('fa-spin');
                    buttonText.text(' Refreshing...').addClass('refreshing');
                    
                    loadTree(true).finally(() => {
                        setTimeout(() => {
                            icon.removeClass('fa-spin');
                            buttonText.text(originalText).removeClass('refreshing');
                        }, 1000);
                    });
                    
                    if (typeof RED !== 'undefined' && RED.notify) {
                        RED.notify(`Force refreshing ${itemType} (bypassing all caches)...`, { type: "warning", timeout: 3000 });
                    }
                }
            });
            
            clearButton.on('click', function() {
                searchInput.val('').trigger('input');
                
                // Collapse all nodes in the tree
                if (treeData && treeView) {
                    treeData.collapseAllNodes();
                    treeView.render();
                    updateCurrentSelection(null);
                    
                    if (typeof RED !== 'undefined' && RED.notify) {
                        RED.notify('Search cleared and tree collapsed', { type: "info", timeout: 2000 });
                    }
                }
                
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
                updateCurrentSelection(null);
                
                if (currentServerId) {
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
                    treeActions.remove();
                    statusElement.remove();
                    searchStatsElement.remove();
                    updateStateLabel(null); // Reset label and remove container class
                    stateInput.show();
                    hideWildcardInfo();
                    $('#wildcard-info-' + nodeType).remove();
                }
            };
            
        } catch (error) {
            throw error;
        }
    }
    
    global.ioBrokerSharedTreeView = {
        version: '1.4.0',
        setup: createTreeView,
        
        HierarchicalTreeData,
        HierarchicalTreeView,
        
        getCacheKey,
        getCachedStates,
        setCachedStates,
        clearCache,
        forceRefreshCache,
        detectWildcardPattern,
        validateWildcardPattern,
        
        initialized: true
    };
    
})(window);