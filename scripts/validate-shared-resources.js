#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SHARED_DIR = path.join(PROJECT_ROOT, 'shared');
const HTML_FILES = [
    'iob-get.html',
    'iob-getobject.html', 
    'iob-in.html',
    'iob-out.html'
];

console.log('🔍 Validating shared TreeView resources...\n');

// Check if shared directory exists
function validateSharedDirectory() {
    console.log('📁 Checking shared directory...');
    
    if (!fs.existsSync(SHARED_DIR)) {
        console.error('❌ ERROR: shared/ directory not found');
        return false;
    }
    
    const treeViewFile = path.join(SHARED_DIR, 'iobroker-treeview.js');
    if (!fs.existsSync(treeViewFile)) {
        console.error('❌ ERROR: shared/iobroker-treeview.js not found');
        return false;
    }
    
    console.log('✅ Shared directory structure OK');
    return true;
}

// Validate TreeView component
function validateTreeViewComponent() {
    console.log('\n🧩 Validating TreeView component...');
    
    const treeViewFile = path.join(SHARED_DIR, 'iobroker-treeview.js');
    const content = fs.readFileSync(treeViewFile, 'utf8');
    
    const requiredElements = [
        'ioBrokerSharedTreeView',
        'HierarchicalTreeData',
        'HierarchicalTreeView',
        'createTreeView',
        'detectWildcardPattern',
        'initialized'
    ];
    
    const missing = requiredElements.filter(element => !content.includes(element));
    
    if (missing.length > 0) {
        console.error('❌ ERROR: TreeView component missing required elements:', missing);
        return false;
    }
    
    // Check for version
    const versionMatch = content.match(/version:\s*['"]([^'"]+)['"]/);
    if (versionMatch) {
        console.log(`📦 TreeView version: ${versionMatch[1]}`);
    }
    
    console.log('✅ TreeView component structure OK');
    return true;
}

// Validate HTML files use shared component
function validateHtmlFiles() {
    console.log('\n📄 Validating HTML files...');
    
    let allValid = true;
    
    HTML_FILES.forEach(filename => {
        const filePath = path.join(PROJECT_ROOT, filename);
        
        if (!fs.existsSync(filePath)) {
            console.error(`❌ ERROR: ${filename} not found`);
            allValid = false;
            return;
        }
        
        const content = fs.readFileSync(filePath, 'utf8');
        
        // Check for shared TreeView usage
        const hasSharedLoader = content.includes('loadSharedTreeView') || 
                               content.includes('ioBrokerSharedTreeView');
        
        if (!hasSharedLoader) {
            console.error(`❌ ERROR: ${filename} doesn't use shared TreeView component`);
            allValid = false;
            return;
        }
        
        // Check that old TreeView code is removed
        const hasOldTreeView = content.includes('ioBrokerOptimizedTreeView') &&
                              content.includes('HierarchicalTreeData') &&
                              content.includes('class HierarchicalTreeData');
        
        if (hasOldTreeView) {
            console.warn(`⚠️  WARNING: ${filename} may still contain old TreeView code`);
        }
        
        // Check for specific node configurations
        const nodeTypeMatch = filename.match(/iob-([^.]+)\.html/);
        if (nodeTypeMatch) {
            const nodeType = nodeTypeMatch[1];
            const hasNodeTypeConfig = content.includes(`nodeType: 'iob${nodeType}'`);
            
            if (!hasNodeTypeConfig) {
                console.warn(`⚠️  WARNING: ${filename} missing proper nodeType configuration`);
            }
        }
        
        console.log(`✅ ${filename} OK`);
    });
    
    return allValid;
}

// Check for potential duplicate code
function checkForDuplicates() {
    console.log('\n🔍 Checking for duplicate TreeView code...');
    
    let totalTreeViewCode = 0;
    let duplicateFound = false;
    
    HTML_FILES.forEach(filename => {
        const filePath = path.join(PROJECT_ROOT, filename);
        if (!fs.existsSync(filePath)) return;
        
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        
        // Count lines that look like TreeView implementation
        const treeViewLines = lines.filter(line => 
            line.includes('HierarchicalTreeData') ||
            line.includes('HierarchicalTreeView') ||
            line.includes('performSearch') ||
            line.includes('buildFromStates')
        ).length;
        
        if (treeViewLines > 5) {
            console.warn(`⚠️  WARNING: ${filename} contains ${treeViewLines} lines of potential TreeView code`);
            duplicateFound = true;
        }
        
        totalTreeViewCode += treeViewLines;
    });
    
    if (duplicateFound) {
        console.log(`📊 Total TreeView-related lines in HTML files: ${totalTreeViewCode}`);
        console.log('💡 Consider removing remaining duplicate code');
    } else {
        console.log('✅ No significant duplicate TreeView code found');
    }
    
    return !duplicateFound;
}

// Calculate size savings
function calculateSizeSavings() {
    console.log('\n📈 Calculating size savings...');
    
    const sharedTreeViewSize = fs.statSync(path.join(SHARED_DIR, 'iobroker-treeview.js')).size;
    let totalHtmlSize = 0;
    
    HTML_FILES.forEach(filename => {
        const filePath = path.join(PROJECT_ROOT, filename);
        if (fs.existsSync(filePath)) {
            totalHtmlSize += fs.statSync(filePath).size;
        }
    });
    
    console.log(`📁 Shared TreeView size: ${(sharedTreeViewSize / 1024).toFixed(1)} KB`);
    console.log(`📁 Total HTML files size: ${(totalHtmlSize / 1024).toFixed(1)} KB`);
    
    // Estimated size before refactoring (rough calculation)
    const estimatedOldSize = totalHtmlSize + (sharedTreeViewSize * HTML_FILES.length);
    const currentSize = totalHtmlSize + sharedTreeViewSize;
    const savings = estimatedOldSize - currentSize;
    
    console.log(`💾 Estimated size savings: ${(savings / 1024).toFixed(1)} KB (${((savings / estimatedOldSize) * 100).toFixed(1)}%)`);
}

// Run all validations
function runValidation() {
    const results = {
        sharedDir: validateSharedDirectory(),
        treeViewComponent: validateTreeViewComponent(),
        htmlFiles: validateHtmlFiles(),
        duplicates: checkForDuplicates()
    };
    
    calculateSizeSavings();
    
    console.log('\n📋 Validation Summary:');
    console.log(`   Shared Directory: ${results.sharedDir ? '✅' : '❌'}`);
    console.log(`   TreeView Component: ${results.treeViewComponent ? '✅' : '❌'}`);
    console.log(`   HTML Files: ${results.htmlFiles ? '✅' : '❌'}`);
    console.log(`   No Duplicates: ${results.duplicates ? '✅' : '⚠️'}`);
    
    const allPassed = Object.values(results).every(result => result === true);
    
    if (allPassed) {
        console.log('\n🎉 All validations passed! Shared TreeView implementation is ready.');
        process.exit(0);
    } else {
        console.log('\n❌ Some validations failed. Please review and fix the issues above.');
        process.exit(1);
    }
}

// Run the validation if called directly
if (require.main === module) {
    runValidation();
}

module.exports = {
    validateSharedDirectory,
    validateTreeViewComponent,
    validateHtmlFiles,
    checkForDuplicates,
    calculateSizeSavings,
    runValidation
};