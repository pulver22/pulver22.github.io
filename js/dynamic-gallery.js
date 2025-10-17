function initializeDynamicGallery(galleryId, galleryUrl, galleryTitle, recursive = false) {
  $(document).ready(function() {
    const gallery = $(galleryId);
    if (!gallery.length) {
      return; // Exit if the gallery container doesn't exist on this page
    }

    const loadingMessage = $('#loading-message');

    function createImageElement(imageUrl) {
      return `
        <div class="md-3 imageuh" data-src="${imageUrl}" data-sub-html="<h4>Image from ${galleryTitle}</h4>">
          <a href="#">
            <img src="${imageUrl}" alt="${galleryTitle} Image" class="img-fluid img-responsive">
          </a>
        </div>`;
    }

    function showError(message) {
      loadingMessage.remove();
      gallery.append(`<div class="alert alert-danger"><strong>Error:</strong> ${message}</div>`);
    }

    function processImages(imageUrls) {
      loadingMessage.remove();

      imageUrls.forEach(imageUrl => {
        gallery.append(createImageElement(imageUrl));
      });

      // Destroy any existing instance before creating a new one
      if (gallery.data('lightGallery')) {
        gallery.data('lightGallery').destroy(true);
      }

      gallery.lightGallery({ selector: '.imageuh' });
    }

    function fetchAndProcess(url, isRecursive) {
      return fetch(url)
        .then(response => {
          if (!response.ok) {
            throw new Error(`Network response was not ok for ${url}`);
          }
          // Clone the response so we can read it twice
          const clonedResponse = response.clone();
          return clonedResponse.json().catch(() => response.text());
        })
        .then(data => {
          if (typeof data === 'string') {
            // It's HTML, so we need to parse it to find links
            const parser = new DOMParser();
            const doc = parser.parseFromString(data, 'text/html');
            const links = Array.from(doc.querySelectorAll('a'));
            // Exclude parent directory link and other non-image/dir links
            return links.map(a => a.getAttribute('href')).filter(href => href && !href.startsWith('?') && href !== '../');
          }
          // It's already JSON
          return data;
        });
    }

    if (recursive) {
      fetchAndProcess(galleryUrl, true)
        .then(entries => {
          const imageFilter = file => /\.(jpg|jpeg|png|gif)$/i.test(file);
          const rootImageUrls = entries
            .filter(entry => imageFilter(entry))
            .map(imageFile => `${galleryUrl}${encodeURIComponent(imageFile)}`);

          const subfolders = entries.filter(entry => !imageFilter(entry));

          const fetchPromises = subfolders.map(subfolder => {
            const subfolderUrl = `${galleryUrl}${encodeURIComponent(subfolder.endsWith('/') ? subfolder : subfolder + '/')}`;
            return fetchAndProcess(subfolderUrl, false)
              .then(imageFiles =>
                imageFiles
                  .filter(imageFilter)
                  .map(imageFile => `${subfolderUrl}${encodeURIComponent(imageFile)}`)
              );
          });

          return Promise.all(fetchPromises).then(imageArrays => {
            // Flatten the array of arrays into a single array and add root images
            return rootImageUrls.concat.apply([], imageArrays);
          });
        })
        .then(allImageUrls => {
          processImages(allImageUrls);
        })
        .catch(error => {
          console.error('Error fetching recursive images:', error);
          showError(`Could not load images from the gallery. <br>
                     This could be a <strong>CORS policy issue</strong> or a problem with the server response.
                     Please check the browser's developer console (F12) for more details.`);
        });
    } else {
      fetchAndProcess(galleryUrl, false)
        .then(imageFiles => {
          const imageUrls = imageFiles
            .filter(file => /\.(jpg|jpeg|png|gif)$/i.test(file)) // Ensure we only process image files
            .map(imageFile => galleryUrl + encodeURIComponent(imageFile)).sort();
          processImages(imageUrls);
        })
        .catch(error => {
          console.error('Error fetching images:', error);
          showError(`Could not load images from the gallery. <br>
                     This could be a <strong>CORS policy issue</strong> or a problem with the server response.
                     Please check the browser's developer console (F12) for more details.`);
        });
    }
  });
}