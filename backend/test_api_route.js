const url = 'http://localhost:3000/api/v1/maps/route?start=77.6080,12.9740&end=77.6400,12.9780';

fetch(url)
.then(async res => {
    console.log('Status code:', res.status);
    const data = await res.json();
    console.log('Success:', data.success);
    if (data.success) {
        console.log('Routes count:', data.data?.routes?.length);
        if (data.data?.routes?.[0]) {
            const route = data.data.routes[0];
            console.log('Route properties:', Object.keys(route));
            console.log('Geometry properties:', route.geometry ? Object.keys(route.geometry) : 'none');
            console.log('Geometry Coordinates count:', route.geometry?.coordinates?.length);
            console.log('Sample Coordinates:', route.geometry?.coordinates?.slice(0, 3));
        }
    } else {
        console.log('Error message:', data.message);
    }
})
.catch(err => console.error(err));
