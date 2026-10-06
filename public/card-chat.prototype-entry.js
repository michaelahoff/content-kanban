// Keep the normal board at /; mount the throwaway variants only by opt-in.
if(new URLSearchParams(location.search).get('prototype')==='card-chat') await import('./card-chat.prototype.js');
else await import('./app.js');
