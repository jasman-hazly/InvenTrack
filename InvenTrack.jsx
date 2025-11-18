import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged,
  signInWithCustomToken 
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  onSnapshot, 
  collection, 
  writeBatch,
  query,
  updateDoc,
  setLogLevel,
  getDocs
} from 'firebase/firestore';

// --- Helper: CSV Parser ---
// Simple CSV parser for "name,category" format
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const nameIndex = headers.indexOf('name');
  const categoryIndex = headers.indexOf('category');

  if (nameIndex === -1 || categoryIndex === -1) {
    throw new Error('CSV must contain "name" and "category" columns.');
  }

  const items = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const values = lines[i].split(',');
    const name = values[nameIndex] ? values[nameIndex].trim() : '';
    const category = values[categoryIndex] ? values[categoryIndex].trim() : 'Uncategorized';
    
    if (name) { // Only add if name is not empty
      items.push({ name, category, taken: false });
    }
  }
  return items;
}

// --- Firebase Initialization ---
const firebaseConfig = typeof __firebase_config !== 'undefined' 
  ? JSON.parse(__firebase_config) 
  : { apiKey: "YOUR_FALLBACK_API_KEY", authDomain: "...", projectId: "..." }; // Fallback config

const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
setLogLevel('Debug'); // Enable Firestore logging

// --- Main App Component ---
export default function App() {
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [userId, setUserId] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(null); // <-- NEW STATE
  
  // Effect for Authentication
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setUserId(user.uid);
      } else {
        try {
          // Use token if available, else sign in anonymously
          if (typeof __initial_auth_token !== 'undefined') {
            await signInWithCustomToken(auth, __initial_auth_token);
          } else {
            await signInAnonymously(auth);
          }
        } catch (authError) {
          console.error("Authentication error:", authError);
          setError("Failed to authenticate. Please refresh.");
        }
      }
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Effect for Subscribing to Firestore Data
  useEffect(() => {
    if (!isAuthReady || !userId) {
      // Don't subscribe until auth is ready and we have a user ID
      return;
    }

    setIsLoading(true);
    // Path to the public collection for this app
    const collectionPath = `artifacts/${appId}/public/data/inventory`;
    const q = query(collection(db, collectionPath));

    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      const dbItems = [];
      const dbCategories = new Set(['All']);
      
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        dbItems.push({ id: doc.id, ...data });
        if (data.category) {
          dbCategories.add(data.category);
        }
      });
      
      setItems(dbItems);
      setCategories(Array.from(dbCategories)); // Convert Set to Array
      setIsLoading(false);
      setError(null);
    }, (err) => {
      console.error("Firestore snapshot error:", err);
      setError("Failed to load items. Check console for details.");
      setIsLoading(false);
    });

    // Cleanup subscription on unmount
    return () => unsubscribe();

  }, [isAuthReady, userId]); // Re-run when auth is ready

  // --- Event Handlers ---

  // Handle CSV File Upload
  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    setUploadSuccess(null); // <-- Reset success message

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const parsedItems = parseCSV(e.target.result);
        if (parsedItems.length === 0) {
          throw new Error("No valid items found in the CSV.");
        }

        // Use a batch write for efficiency
        const batch = writeBatch(db);
        const collectionPath = `artifacts/${appId}/public/data/inventory`;

        // --- NEW: Delete all existing items first ---
        const existingItemsQuery = query(collection(db, collectionPath));
        const querySnapshot = await getDocs(existingItemsQuery);
        querySnapshot.forEach((doc) => {
          batch.delete(doc.ref);
        });
        // --- End of new logic ---
        
        parsedItems.forEach(item => {
          const newItemRef = doc(collection(db, collectionPath)); // Create a new doc with auto-ID
          batch.set(newItemRef, item);
        });

        await batch.commit();
        setUploadSuccess(`Successfully uploaded ${parsedItems.length} items!`); // <-- Set success message
        setUploading(false);
        
        // Optional: Clear message after 5 seconds
        setTimeout(() => setUploadSuccess(null), 5000);

      } catch (err) {
        console.error("Upload error:", err);
        setError(`Upload Failed: ${err.message}`);
        setUploading(false);
      }
    };
    reader.onerror = () => {
      setError("Failed to read the file.");
      setUploading(false);
    };
    reader.readAsText(file);
  };

  // Handle "Take Item" button click
  const handleTakeItem = async (itemId, currentStatus) => {
    if (!userId) {
      setError("You must be signed in to take an item.");
      return;
    }
    const itemRef = doc(db, `artifacts/${appId}/public/data/inventory`, itemId);
    try {
      // Toggle the 'taken' status
      await updateDoc(itemRef, {
        taken: !currentStatus
      });
    } catch (err) {
      console.error("Error updating item:", err);
      setError("Failed to update item.");
    }
  };

  // --- Memoized Derived State ---

  // Filter items by category FIRST
  const categoryFilteredItems = useMemo(() => {
    if (selectedCategory === 'All') {
      return items;
    }
    return items.filter(item => item.category === selectedCategory);
  }, [items, selectedCategory]);

  // THEN, filter by search query
  const displayedItems = useMemo(() => {
    if (!searchQuery) {
      return categoryFilteredItems; // No search, return category-filtered list
    }
    const lowerCaseQuery = searchQuery.toLowerCase();
    return categoryFilteredItems.filter(item =>
      item.name.toLowerCase().includes(lowerCaseQuery)
    );
  }, [categoryFilteredItems, searchQuery]);

  // Calculate dashboard stats based on CATEGORY filter (not search)
  const dashboardStats = useMemo(() => {
    const sourceItems = categoryFilteredItems; // Base stats on the selected category
    const total = sourceItems.length;
    const taken = sourceItems.filter(item => item.taken).length;
    const notTaken = total - taken;
    return { total, taken, notTaken };
  }, [categoryFilteredItems]); // Recalculate when category filter changes

  // --- Render ---

  if (!isAuthReady || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="text-xl font-medium text-gray-700">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 font-inter p-4 sm:p-8">
      <div className="max-w-4xl mx-auto">
        
        {/* Header */}
        <header className="mb-6 p-6 bg-white rounded-lg shadow-lg">
          <h1 className="text-3xl font-bold text-gray-900 mb-4">Real-Time Inventory Tracker</h1>
          <p className="text-sm text-gray-500 mb-4">User ID: {userId}</p>
          
          <div className="flex items-center gap-4">
            <label className="relative inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 cursor-pointer">
              {uploading ? 'Uploading...' : 'Upload CSV'}
              <input 
                type="file" 
                className="absolute left-0 top-0 w-full h-full opacity-0 cursor-pointer" 
                accept=".csv"
                onChange={handleFileUpload}
                disabled={uploading}
              />
            </label>
            
            {/* Success Message displayed on the side */}
            {uploadSuccess && (
              <span className="text-emerald-600 text-sm font-medium">
                {uploadSuccess}
              </span>
            )}
          </div>

          {error && <p className="text-red-500 text-sm mt-4">{error}</p>}
        </header>

        {/* Dashboard Section */}
        <div className="mb-6 p-6 bg-white rounded-lg shadow-lg">
          <h2 className="text-xl font-semibold mb-4">
            Dashboard: <span className="text-indigo-600">{selectedCategory === 'All' ? 'Overall' : selectedCategory}</span>
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Total Items */}
            <div className="p-4 bg-blue-100 rounded-lg text-center">
              <span className="text-3xl font-bold text-blue-800">{dashboardStats.total}</span>
              <p className="text-sm font-medium text-blue-700">Total Items</p>
            </div>
            {/* Items Taken */}
            <div className="p-4 bg-red-100 rounded-lg text-center">
              <span className="text-3xl font-bold text-red-800">{dashboardStats.taken}</span>
              <p className="text-sm font-medium text-red-700">Items Taken</p>
            </div>
            {/* Items Not Taken */}
            <div className="p-4 bg-emerald-100 rounded-lg text-center">
              <span className="text-3xl font-bold text-emerald-800">{dashboardStats.notTaken}</span>
              <p className="text-sm font-medium text-emerald-700">Items Not Taken</p>
            </div>
          </div>
        </div>

        {/* Filter Section */}
        <div className="mb-4 p-4 bg-white rounded-lg shadow-lg">
          <h3 className="text-lg font-medium mb-3">Filter by Category</h3>
          <div className="flex flex-wrap gap-2">
            {categories.map(category => (
              <button
                key={category}
                onClick={() => setSelectedCategory(category)}
                className={`px-4 py-2 text-sm font-medium rounded-full transition-all duration-150
                  ${selectedCategory === category
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
              >
                {category}
              </button>
            ))}
          </div>
        </div>

        {/* Item List Section */}
        <main className="bg-white rounded-lg shadow-lg overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-xl font-semibold">
              Item List ({displayedItems.length})
            </h2>
            {/* --- SEARCH BAR --- */}
            <input
              type="text"
              placeholder="Search by name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full mt-4 p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          
          <ul className="divide-y divide-gray-200">
            {displayedItems.length > 0 ? (
              displayedItems.map(item => (
                <ItemRow 
                  key={item.id} 
                  item={item} 
                  onTakeItem={handleTakeItem}
                  showCategory={selectedCategory === 'All'}
                />
              ))
            ) : (
              <li className="p-6 text-center text-gray-500">
                {items.length === 0 
                  ? "Upload a CSV to get started." 
                  : (searchQuery
                      ? "No items match your search."
                      : "No items found for this category.")
                }
              </li>
            )}
          </ul>
        </main>
      </div>
    </div>
  );
}

// --- Child Component: ItemRow ---
function ItemRow({ item, onTakeItem, showCategory }) {
  const isTaken = item.taken;
  
  return (
    <li 
      className={`p-4 flex items-center justify-between transition-all ${isTaken ? 'opacity-60 bg-gray-50' : 'bg-white'}`}
    >
      <div className="flex-1">
        <h3 className="text-lg font-medium text-gray-900">{item.name}</h3>
        {/* Conditionally show category */}
        {showCategory && (
          <p className="text-sm text-gray-500">{item.category}</p>
        )}
      </div>
      
      <div className="flex-shrink-0 ml-4">
        {isTaken ? (
          <button 
            onClick={() => onTakeItem(item.id, item.taken)}
            className="px-4 py-2 text-sm font-medium rounded-md text-gray-700 bg-gray-200 hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-400"
          >
            Return
          </button>
        ) : (
          <button 
            onClick={() => onTakeItem(item.id, item.taken)}
            className="px-4 py-2 text-sm font-medium rounded-md text-white bg-teal-600 hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-teal-500"
          >
            Take Item
          </button>
        )}
      </div>
    </li>
  );
}
